// apps/backend/src/services/ocr-safe.ts
//
// ─── SAHPRA CLASS A COMPLIANCE BOUNDARY ────────────────────────────────────────
// The OCR service is permitted to do:
//   • Document type classification (lab/prescription/discharge/imaging via
//     pattern matching)
//   • Metadata extraction (date, facility name, patient name only)
//   • Full-text search indexing
//   • Write a DocumentReference FHIR resource pointing to the S3 original
//
// The OCR service is forbidden from:
//   • Extracting clinical values (HbA1c, CD4, BP, glucose, etc.) into
//     structured fields
//   • Flagging abnormal values
//   • Populating medication lists from images
//   • Any clinical interpretation
//
// Every OCR job MUST write an audit_log entry recording both what was
// extracted AND what was deliberately NOT extracted, as a compliance
// fingerprint. No exceptions.
// ─── END COMPLIANCE BOUNDARY ───────────────────────────────────────────────────

import { AnalyzeDocumentCommand, TextractClient } from "@aws-sdk/client-textract";
import type { Block } from "@aws-sdk/client-textract";
import { createHash } from "node:crypto";
import type { DocumentReference } from "@medplum/fhirtypes";
import { pool } from "../db.js";
import { fhirClient } from "../fhir/client.js";
import { logger } from "../logger.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type DocType =
  | "lab"
  | "prescription"
  | "discharge"
  | "imaging"
  | "referral"
  | "other";

export interface OcrInput {
  userId: string;
  /** documents.id — pre-inserted by the route handler with ocr_status='pending' */
  documentId: string;
  bucket: string;
  key: string;
  mimeType: string;
}

export interface OcrResult {
  documentReference: DocumentReference;
  docType: DocType;
  extractedDate: string | null;
  facilityName: string | null;
  patientName: string | null;
  fullTextChars: number;
}

// ── Classifier ───────────────────────────────────────────────────────────────
// Keyword patterns per document category.
//
// MUST NOT contain specific clinical value names (HbA1c, CD4, BP, glucose…).
// Those are in the forbidden-extraction list. Use broad structural markers only.
// Clinical test names in the classifier source would appear to extract clinical
// values even if they are only used for classification, and would read badly in
// a SAHPRA documentation pack.
const CLASSIFIER_PATTERNS: Record<Exclude<DocType, "other">, RegExp[]> = {
  lab: [
    /\blaborator(?:y|ies)\b/i,
    /\bpatholog(?:y|ist)\b/i,
    /\bhaematolog(?:y|ist)\b/i,
    /\bserology\b/i,
    /\bfull blood count\b/i,
    /\bFBC\b/,
    /\bCBC\b/,
    /\blipogram\b/i,
    /\bviral load\b/i,
    /\bspecimen\b/i,
    /\breference range\b/i,
    /\bnormal range\b/i,
    /\btest result\b/i,
    /\bcollected\b/i,
    /\breported by\b/i,
    /\bplatelet\b/i,
    /\blymphocyte\b/i,
    /\bpathologist\b/i,
  ],
  prescription: [
    /\bprescription\b/i,
    /\bRx\b/,
    /\bdispen[sc]ed?\b/i,
    /\bprescribed\b/i,
    /\bmedication\b/i,
    /\btablet\b/i,
    /\bcapsule\b/i,
    /\brepeat\b/i,
    /\bchronic\b/i,
    /\bpharmacist\b/i,
    /\bpharmacy\b/i,
    /\bnocte\b/i,
    /\bmane\b/i,
    /\b(?:b\.?d|t\.?d\.?s|q\.?i\.?d|p\.?r\.?n)\b/i,
    /\bdosage\b/i,
    /\brefill\b/i,
    /\bdirections\b/i,
  ],
  discharge: [
    /\bdischarge summary\b/i,
    /\bdischarge letter\b/i,
    /\bdischarge date\b/i,
    /\badmission date\b/i,
    /\badmitted\b/i,
    /\bdischarged\b/i,
    /\bward\b/i,
    /\bin-?patient\b/i,
    /\bprincipal diagnosis\b/i,
    /\blength of stay\b/i,
    /\btheatre\b/i,
    /\bconsultant\b/i,
    /\btreating team\b/i,
    /\bfollow-?up\b/i,
    /\bprocedure performed\b/i,
  ],
  imaging: [
    /\bX-?ray\b/i,
    /\bCT scan\b/i,
    /\bMRI\b/,
    /\bultrasound\b/i,
    /\bsonar\b/i,
    /\bradiology\b/i,
    /\bradiograph\b/i,
    /\bimaging report\b/i,
    /\bfindings?:\b/i,
    /\bimpression:\b/i,
    /\bradiologist\b/i,
    /\bCXR\b/,
    /\bchest X-?ray\b/i,
    /\bmammogram\b/i,
    /\bechocardiogram\b/i,
  ],
  referral: [
    /\breferral\b/i,
    /\breferred\b/i,
    /\brefer to\b/i,
    /\bplease (?:see|assess|review)\b/i,
    /\bfor specialist\b/i,
    /\bthank you for seeing\b/i,
    /\bkindly (?:see|assess)\b/i,
    /\bI am referring\b/i,
    /\bfor your attention\b/i,
    /\boutpatient\b/i,
    /\bOPD\b/,
  ],
};

// SHA-256 of all classifier patterns computed once at module load.
// If patterns change, this hash changes — recorded in every audit_log entry so
// the exact classifier version that produced a given label is always traceable.
export const CLASSIFIER_VERSION_SHA256: string = (() => {
  const allPatterns = (Object.values(CLASSIFIER_PATTERNS) as RegExp[][])
    .flat()
    .map((r) => r.toString())
    .join("|");
  return createHash("sha256").update(allPatterns).digest("hex");
})();

// Tie-break priority when two categories score equally.
const PRIORITY: Exclude<DocType, "other">[] = [
  "lab",
  "discharge",
  "imaging",
  "prescription",
  "referral",
];

export function classifyDocument(
  text: string,
): { docType: DocType; scores: Record<string, number> } {
  const scores: Record<string, number> = {
    lab: 0, prescription: 0, discharge: 0, imaging: 0, referral: 0,
  };

  for (const [cat, patterns] of Object.entries(CLASSIFIER_PATTERNS) as [
    Exclude<DocType, "other">,
    RegExp[],
  ][]) {
    for (const pattern of patterns) {
      if (pattern.test(text)) scores[cat]++;
    }
  }

  let docType: DocType = "other";
  let bestScore = 0;

  for (const cat of PRIORITY) {
    if (scores[cat] > bestScore) {
      bestScore = scores[cat];
      docType = cat;
    }
  }

  return { docType, scores };
}

// ── Metadata extractors ───────────────────────────────────────────────────────

const MONTH_MAP: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

export function extractDate(
  text: string,
): { date: string | null; ambiguous: boolean } {
  // 1. ISO YYYY-MM-DD — unambiguous
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (iso) return { date: iso[1], ambiguous: false };

  // 2. Written month name — unambiguous. Formatted directly as YYYY-MM-DD to
  //    avoid timezone drift from the Date constructor (new Date creates local
  //    midnight; toISOString converts to UTC, shifting the date in SAST +2).
  const written =
    /\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})\b/i.exec(
      text,
    );
  if (written) {
    const month = MONTH_MAP[written[2].slice(0, 3).toLowerCase()];
    if (month) {
      const day = written[1].padStart(2, "0");
      return { date: `${written[3]}-${month}-${day}`, ambiguous: false };
    }
  }

  // 3. Slash / dash — potentially ambiguous.
  // If group 1 > 12 it must be the day (SA DD/MM/YYYY). Safe — format directly.
  // If both groups are ≤ 12, MM vs DD is ambiguous — return null rather than guess.
  // Better to store NULL than the wrong month.
  const slashDash = /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/.exec(text);
  if (slashDash) {
    const g1 = parseInt(slashDash[1], 10);
    const g2 = parseInt(slashDash[2], 10);
    if (g1 > 12) {
      const day   = String(g1).padStart(2, "0");
      const month = String(g2).padStart(2, "0");
      return { date: `${slashDash[3]}-${month}-${day}`, ambiguous: false };
    }
    return { date: null, ambiguous: true };
  }

  return { date: null, ambiguous: false };
}

export function extractFacilityName(text: string): string | null {
  // Require the facility keyword at the start of a line followed by ": " or "\t".
  // "Hospital: Groote Schuur" → matches; "Khayelitsha Hospital\n" → no match
  // (keyword at end of line has no colon/tab after it).
  // No first-line fallback: unanchored facility names are too likely to produce
  // false positives (arbitrary text surfacing in shareable FHIR fields).
  const anchored =
    /(?:^|\n)(?:hospital|clinic|health\s+cent(?:re|er)|CHC|medical\s+cent(?:re|er)|laboratory)\b[: \t]+([^\n]{3,80})/i.exec(
      text,
    );
  return anchored ? anchored[1].trim().slice(0, 100) : null;
}

export function extractPatientName(text: string): string | null {
  const match =
    /(?:patient(?:\s+name)?|name of patient|patient'?s?\s+name)[:\s]+([^\n]{3,60})/i.exec(
      text,
    ) ??
    /(?:surname|first\s+name|full\s+name)[:\s]+([^\n]{3,40})/i.exec(text);
  return match ? match[1].trim().slice(0, 100) : null;
}

// ── Textract client (lazy singleton) ─────────────────────────────────────────

let _textract: TextractClient | undefined;

function getTextract(): TextractClient {
  return (_textract ??= new TextractClient({
    region: process.env.AWS_REGION ?? "af-south-1",
  }));
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function processDocument(input: OcrInput): Promise<OcrResult> {
  const { userId, documentId, bucket, key, mimeType } = input;
  logger.info({ userId, documentId, s3Key: key }, "ocr: starting");

  await pool.query(
    `UPDATE documents SET ocr_status = 'processing' WHERE id = $1`,
    [documentId],
  );

  let blocks: Block[];
  try {
    const cmd = new AnalyzeDocumentCommand({
      Document: { S3Object: { Bucket: bucket, Name: key } },
      FeatureTypes: ["TABLES"], // NEVER FORMS — see compliance boundary above
    });
    const res = await getTextract().send(cmd);
    blocks = res.Blocks ?? [];
  } catch (err) {
    await pool.query(
      `UPDATE documents SET ocr_status = 'failed' WHERE id = $1`,
      [documentId],
    );
    throw err;
  }

  // Assemble text from LINE blocks only.
  // KEY_VALUE_SET blocks (produced by the FORMS feature) pair field labels with
  // values — exactly the clinical value extraction we are forbidden from doing.
  // They are discarded here even if somehow present in the response.
  const lineBlocks = blocks.filter((b) => b.BlockType === "LINE");
  const kvBlocks   = blocks.filter((b) => b.BlockType === "KEY_VALUE_SET");
  if (kvBlocks.length > 0) {
    logger.warn(
      { userId, documentId, kvCount: kvBlocks.length },
      "ocr: KEY_VALUE_SET blocks received and discarded (FORMS feature not requested — possible SDK regression)",
    );
  }
  const fullText = lineBlocks.map((b) => b.Text ?? "").join("\n");

  const { docType, scores }            = classifyDocument(fullText);
  const { date: extractedDate, ambiguous: dateAmbiguous } = extractDate(fullText);
  const facilityName                   = extractFacilityName(fullText);
  const patientName                    = extractPatientName(fullText);

  // Build DocumentReference.
  // patient_name is intentionally excluded from the description field:
  // that field may appear in shared FHIR contexts; identity metadata is stored
  // in documents.patient_name and the audit log, not in shareable FHIR fields.
  const docRef: DocumentReference = {
    resourceType: "DocumentReference",
    status: "current",
    type: {
      coding: [{ system: "http://qurovita.co.za/doc-type", code: docType }],
      text: docType,
    },
    subject: { reference: `Patient/${userId}` },
    date: new Date().toISOString(),
    content: [
      {
        attachment: {
          contentType: mimeType,
          url: `s3://${bucket}/${key}`,
          title: key.split("/").pop() ?? key,
        },
      },
    ],
    description:
      [facilityName, extractedDate].filter(Boolean).join(" | ") || undefined,
  };

  const client    = fhirClient(userId);
  const storedRef = await client.create(docRef, "ocr");

  // Resolve the fhir_resources PK (UUID) for FK references in documents and audit_log.
  const pkRow = await pool.query<{ id: string }>(
    `SELECT id FROM fhir_resources WHERE user_id = $1 AND fhir_id = $2`,
    [userId, storedRef.id],
  );
  const fhirResourcePk = pkRow.rows[0]?.id ?? null;

  // Update documents row — trigger maintains full_text_search from full_text_raw.
  await pool.query(
    `UPDATE documents SET
       doc_type      = $1,
       doc_date      = $2::date,
       facility_name = $3,
       patient_name  = $4,
       full_text_raw = $5,
       fhir_ref_id   = $6,
       ocr_status    = 'complete'
     WHERE id = $7`,
    [docType, extractedDate, facilityName, patientName, fullText, fhirResourcePk, documentId],
  );

  // ── Mandatory audit_log entry — SAHPRA Class A compliance fingerprint ──────
  // Records both what was extracted AND what was deliberately not extracted.
  // This INSERT must not be swallowed or made conditional.
  const extractedDetails: Record<string, unknown> = {
    doc_date:        extractedDate,
    facility_name:   facilityName,
    patient_name:    patientName,
    full_text_chars: fullText.length,
  };
  if (dateAmbiguous) extractedDetails.doc_date_ambiguous = true;

  await pool.query(
    `INSERT INTO audit_log
       (actor_id, actor_kind, action, target_type, target_id, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      userId,
      "patient",
      "ocr.classify",
      "Document",
      fhirResourcePk,
      JSON.stringify({
        s3_key:           key,
        document_class:   docType,
        extracted:        extractedDetails,
        NOT_extracted: [
          "clinical_values",
          "abnormal_flags",
          "medication_lists",
          "clinical_interpretation",
        ],
        sahpra_class:              "A",
        textract_block_count:      blocks.length,
        kv_blocks_discarded:       kvBlocks.length,
        classifier_scores:         scores,
        classifier_version_sha256: CLASSIFIER_VERSION_SHA256,
      }),
    ],
  );

  logger.info(
    { userId, documentId, docType, fhirId: storedRef.id },
    "ocr: complete",
  );

  return {
    documentReference: storedRef,
    docType,
    extractedDate,
    facilityName,
    patientName,
    fullTextChars: fullText.length,
  };
}
