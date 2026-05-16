// T3.1 / T3.2 — SAHPRA Class A OCR service tests.
// Covers: classifier accuracy (≥90% gate), metadata extractors, compliance
// negative tests, and integration tests for processDocument with mocked Textract.

import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";

// vi.hoisted runs before module resolution — mockSend is available in vi.mock factory.
const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock("@aws-sdk/client-textract", () => ({
  TextractClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  AnalyzeDocumentCommand: vi.fn().mockImplementation((p: unknown) => p),
}));

import {
  CLASSIFIER_VERSION_SHA256,
  classifyDocument,
  extractDate,
  extractFacilityName,
  extractPatientName,
  processDocument,
  type DocType,
} from "../src/services/ocr-safe.js";
import { pool } from "../src/db.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

type Fixture = { text: string; expected: DocType };

const FIXTURES: Fixture[] = [
  // ── lab (6) ─────────────────────────────────────────────────────────────
  { expected: "lab", text: "Groote Schuur Hospital\nDepartment of Laboratory Medicine\nPatient: Sipho Dlamini\nDate: 2025-03-14\nFull Blood Count report\nSpecimen collected\nReference range provided\nPathologist: Dr A Smith" },
  { expected: "lab", text: "NHLS LABORATORY REPORT\nSerology\nPatient Name: Thandi Mokoena\nViral load assay\nSpecimen type: EDTA\nTest result: see below\nReported by: Lab technician\nNormal range included" },
  { expected: "lab", text: "Netcare Pathology\nLipogram\nFull Blood Count\nCBC analysis\nDate collected: 2026-01-10\nReference range: see table\nPathologist signature required" },
  { expected: "lab", text: "Lancet Laboratories\nPatient: Jane Nkosi\nHaematology panel\nPlatelet count\nLymphocyte differential\nSpecimen received 09:14\nReported by Dr Botha" },
  { expected: "lab", text: "Western Cape Laboratory Services\nFull Blood Count\nTest result: pending\nSpecimen: whole blood\nNormal range provided on report\nCollected at Somerset Hospital" },
  { expected: "lab", text: "PathCare\nSerology screen\nFBC and differential\nReference range attached\nReported by: pathologist\nLymphocyte count included" },

  // ── prescription (6) ────────────────────────────────────────────────────
  { expected: "prescription", text: "CHRONIC MEDICATION PRESCRIPTION\nPharmacy: Clicks Khayelitsha\nPatient: Jane Nkosi\nMedication list\ntablet\nRepeat x2\nPharmacist signature\nDispensed 2026-01-10" },
  { expected: "prescription", text: "ACUTE PRESCRIPTION\nRx\nDispense the following\nCapsule — take as directed\nNocte\nMane dosage\nPharmacy stamp required\nRefill: once" },
  { expected: "prescription", text: "Dis-Chem Pharmacy\nPrescription number: 88234\nPrescribed by: Dr Lekganyane\nMedication dispensed\ntablet bd\nDirections: as per instructions\nPatient: Mr Dlamini" },
  { expected: "prescription", text: "CHRONIC DISEASE MANAGEMENT\nPharmacist: Ms Sithole\nMedication review\nTablets — repeat x3\nDosage instructions provided\nPharmacy dispensing record\nRepeat prescription attached" },
  { expected: "prescription", text: "Medirite Pharmacy\nRx copy\nPrescribed medication\nCapsule tds\nPatient directions\nRefill authorisation\nPharmacist dispensed 2026-02-01" },
  { expected: "prescription", text: "GOVERNMENT PHARMACY\nChronic medication\nPrescription\nMedication: tablet\nDosage: mane\nDirections enclosed\nDispensed by pharmacist\nRepeat: 2" },

  // ── discharge (5) ────────────────────────────────────────────────────────
  { expected: "discharge", text: "DISCHARGE SUMMARY\nAdmission date: 12/01/2026\nDischarge date: 15/01/2026\nWard: General Medicine\nLength of stay: 3 days\nConsultant: Dr Mokoena\nProcedure performed: appendectomy\nFollow-up: 2 weeks" },
  { expected: "discharge", text: "Discharge letter\nPatient admitted: 2026-01-08\nDischarged: 2026-01-12\nInpatient stay\nWard: Surgical\nTreating team: Prof Botha\nFollow-up appointment booked" },
  { expected: "discharge", text: "GROOTE SCHUUR HOSPITAL\nPatient Discharge Record\nPrincipal diagnosis noted\nAdmitted: 03 February 2026\nDischarged: 07 February 2026\nTheatre: laparoscopy\nLength of stay: 4 days" },
  { expected: "discharge", text: "DISCHARGE LETTER\nDear GP\nThis patient was admitted and discharged from our ward\nConsultant: Dr Hendricks\nProcedure performed under general anaesthesia\nFollow-up in 6 weeks\nTreating team signed off" },
  { expected: "discharge", text: "In-patient discharge record\nWard: Obs & Gynae\nAdmission date: 2025-11-20\nDischarge date: 2025-11-23\nLength of stay: 3 days\nPrincipal diagnosis recorded\nConsultant: Dr van Zyl" },

  // ── imaging (5) ──────────────────────────────────────────────────────────
  { expected: "imaging", text: "RADIOLOGY REPORT\nExamination: Chest X-Ray\nCXR findings: no active pulmonary pathology\nImpression: Normal chest\nRadiologist: Dr Williams\nDate: 2026-01-20" },
  { expected: "imaging", text: "CT Scan report\nImaging report\nFindings: no acute abnormality\nImpression: see below\nRadiologist signed\nDate: 2026-02-14" },
  { expected: "imaging", text: "MRI Brain\nRadiology\nFindings:\nImpression:\nRadiologist: Dr Patel\nReferring: Dr Singh" },
  { expected: "imaging", text: "SONAR / ULTRASOUND\nAbdominal ultrasound report\nFindings: liver unremarkable\nImpression: normal study\nRadiologist report attached" },
  { expected: "imaging", text: "Mammography screening report\nImagingRadiology\nFindings: no suspicious lesion\nImpression: BIRADS 1\nRadiologist: Dr Adams\nDate: 2025-12-01" },

  // ── referral (4) ─────────────────────────────────────────────────────────
  { expected: "referral", text: "REFERRAL LETTER\nDear Dr Botha\nI am referring Mr Dlamini\nPlease see and assess\nFor specialist consultation\nKindly advise\nOPD appointment requested" },
  { expected: "referral", text: "Dear Colleague\nThank you for seeing this patient\nReferral for specialist review\nPlease assess and manage\nFor your attention\nOutpatient follow-up" },
  { expected: "referral", text: "SPECIALIST REFERRAL\nReferred to: Cardiology OPD\nPlease review and advise\nFor specialist assessment\nI am referring this patient for further management\nKindly see at your earliest" },
  { expected: "referral", text: "Dear Dr Mokoena\nReferral letter\nThis patient is referred for specialist opinion\nPlease see and advise\nFor outpatient review\nThank you for seeing" },

  // ── other (4) ────────────────────────────────────────────────────────────
  { expected: "other", text: "INVOICE\nSupplier: Meditech SA\nItem: Surgical gloves x100\nItem: Syringes x200\nTotal: R1 250.00\nVAT included\nPayment due 30 days" },
  { expected: "other", text: "MINUTES OF MEETING\nDate: 15 March 2026\nAttendees: see list\nAgenda: staffing\nAction items: 1. Review rosters" },
  { expected: "other", text: "LEAVE FORM\nEmployee: Nurse Sithole\nDates: 1-5 April 2026\nReason: annual leave\nApproved by: Ward Manager" },
  { expected: "other", text: "STOCK REQUISITION\nDepartment: Pharmacy stores\nItem: PPE supplies\nQuantity: 50 units\nAuthorised by: pharmacy manager" },
];

// ── Classifier accuracy gate ──────────────────────────────────────────────────

describe("classifyDocument — accuracy gate", () => {
  it("classifies ≥90% of 30 fixtures correctly", () => {
    let correct = 0;
    const failures: string[] = [];
    for (const { text, expected } of FIXTURES) {
      const { docType } = classifyDocument(text);
      if (docType === expected) {
        correct++;
      } else {
        failures.push(`Expected "${expected}", got "${docType}" for: ${text.slice(0, 60)}`);
      }
    }
    const accuracy = correct / FIXTURES.length;
    if (failures.length > 0) console.info("Misclassified:", failures);
    expect(accuracy).toBeGreaterThanOrEqual(0.9);
  });

  it.each([
    ["lab",          FIXTURES.filter(f => f.expected === "lab")],
    ["prescription", FIXTURES.filter(f => f.expected === "prescription")],
    ["discharge",    FIXTURES.filter(f => f.expected === "discharge")],
    ["imaging",      FIXTURES.filter(f => f.expected === "imaging")],
    ["referral",     FIXTURES.filter(f => f.expected === "referral")],
  ] as [string, Fixture[]][])(
    "category %s: all fixtures classified correctly",
    (_cat, fixtures) => {
      for (const { text, expected } of fixtures) {
        const { docType } = classifyDocument(text);
        expect(docType).toBe(expected);
      }
    },
  );
});

// ── extractDate ───────────────────────────────────────────────────────────────

describe("extractDate", () => {
  it("parses ISO date", () => {
    expect(extractDate("Report date: 2026-01-14")).toEqual({ date: "2026-01-14", ambiguous: false });
  });

  it("parses written month name", () => {
    expect(extractDate("Date: 14 January 2026")).toEqual({ date: "2026-01-14", ambiguous: false });
    expect(extractDate("3 March 2025")).toEqual({ date: "2025-03-03", ambiguous: false });
  });

  it("parses unambiguous SA DD/MM/YYYY when day > 12", () => {
    // Day = 14, Month = 01 → day > 12, unambiguous
    expect(extractDate("Date: 14/01/2026")).toEqual({ date: "2026-01-14", ambiguous: false });
    expect(extractDate("Date: 25-03-2025")).toEqual({ date: "2025-03-25", ambiguous: false });
  });

  it("returns null + ambiguous=true when both groups ≤ 12", () => {
    // 03/01/2026: could be 3 Jan or 1 Mar — ambiguous
    expect(extractDate("Date: 03/01/2026")).toEqual({ date: null, ambiguous: true });
    expect(extractDate("12-06-2025")).toEqual({ date: null, ambiguous: true });
  });

  it("returns null + ambiguous=false when no date found", () => {
    expect(extractDate("No date here")).toEqual({ date: null, ambiguous: false });
  });
});

// ── extractFacilityName ───────────────────────────────────────────────────────

describe("extractFacilityName", () => {
  it("extracts name after facility keyword", () => {
    expect(extractFacilityName("Hospital: Groote Schuur\nOther lines")).toBe("Groote Schuur");
    expect(extractFacilityName("Clinic: Khayelitsha CHC\nNext line")).toBe("Khayelitsha CHC");
  });

  it("returns null when no keyword appears at the start of a line", () => {
    // "Netcare Christiaan Barnard" has no hospital/clinic keyword at line start
    expect(extractFacilityName("\nNetcare Christiaan Barnard\nMore text")).toBeNull();
    // Keyword mid-line also doesn't match
    expect(extractFacilityName("Next to the Hospital building\nother")).toBeNull();
  });

  it("caps at 100 characters", () => {
    const long = "Hospital: " + "A".repeat(120);
    expect(extractFacilityName(long)!.length).toBeLessThanOrEqual(100);
  });

  it("returns null when text is empty", () => {
    expect(extractFacilityName("")).toBeNull();
  });
});

// ── extractPatientName ────────────────────────────────────────────────────────

describe("extractPatientName", () => {
  it("matches 'Patient Name:' pattern", () => {
    expect(extractPatientName("Patient Name: Thandi Mokoena\nOther")).toBe("Thandi Mokoena");
  });

  it("matches 'Patient:' pattern", () => {
    expect(extractPatientName("Patient: Sipho Dlamini\nDate: 2026")).toBe("Sipho Dlamini");
  });

  it("matches 'Surname:' pattern", () => {
    expect(extractPatientName("Surname: Nkosi\nFirst Name: Jane")).toBe("Nkosi");
  });

  it("returns null when no pattern matches", () => {
    expect(extractPatientName("No name patterns here")).toBeNull();
  });
});

// ── CLASSIFIER_VERSION_SHA256 ─────────────────────────────────────────────────

describe("CLASSIFIER_VERSION_SHA256", () => {
  it("is a 64-char hex string", () => {
    expect(CLASSIFIER_VERSION_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── Compliance negative tests (pure — no DB) ──────────────────────────────────

describe("compliance negative tests — no clinical values extracted", () => {
  it("doc containing 'Cardiomegaly' classifies but produces no diagnosis field", () => {
    const text = "Chest X-Ray\nRadiology report\nFindings: Cardiomegaly noted\nImpression: see radiologist\nRadiologist: Dr Adams";
    const { docType, scores } = classifyDocument(text);
    expect(docType).toBe("imaging");
    // No structured diagnosis field should appear — classification only
    const resultStr = JSON.stringify({ docType, scores });
    expect(resultStr).not.toContain("diagnosis");
    expect(resultStr.toLowerCase()).not.toContain("cardiomegaly");
  });

  it("doc containing 'Increase dose to 20mg' produces no medication string in classifier output", () => {
    const text = "Increase dose to 20mg daily as instructed by your doctor";
    const { docType, scores } = classifyDocument(text);
    // Classified as other or prescription — either is fine
    // The classifier output must not carry the medication dose as a value
    const outputStr = JSON.stringify({ docType, scores });
    expect(outputStr).not.toContain("20mg");
    expect(outputStr).not.toContain("Increase dose");
  });
});

// ── Integration tests — processDocument with mocked Textract and real DB ──────

const TEST_PHONE = "+27099000001";
let testUserId: string;

function lineBlock(text: string) {
  return { BlockType: "LINE", Text: text, Id: randomUUID() };
}

function kvBlock() {
  return { BlockType: "KEY_VALUE_SET", Id: randomUUID() };
}

async function createTestDocument(): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO documents (user_id, s3_bucket, s3_key, mime_type)
     VALUES ($1, 'test-bucket', $2, 'application/pdf') RETURNING id`,
    [testUserId, `test/${randomUUID()}.pdf`],
  );
  return res.rows[0].id;
}

beforeAll(async () => {
  await pool.query(
    `INSERT INTO users (display_name, phone_e164)
     VALUES ('OCR Test User', $1)
     ON CONFLICT (phone_e164) DO UPDATE SET display_name = EXCLUDED.display_name`,
    [TEST_PHONE],
  );
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE phone_e164 = $1`,
    [TEST_PHONE],
  );
  testUserId = r.rows[0].id;
});

afterAll(async () => {
  // fhir_resources and documents both have ON DELETE CASCADE from users,
  // so a single user delete cleans everything up. audit_log rows are
  // append-only (actor_id SET NULL on user delete) — intentionally left.
  await pool.query(`DELETE FROM users WHERE id = $1`, [testUserId]);
});

beforeEach(() => {
  mockSend.mockReset();
});

describe("processDocument — happy path (lab report)", () => {
  it("creates DocumentReference, updates documents row, writes audit_log", async () => {
    const documentId = await createTestDocument();
    const labBlocks = [
      lineBlock("Hospital: Groote Schuur"),   // keyword at line start → facility anchored
      lineBlock("Department of Laboratory Medicine"),
      lineBlock("Patient: Sipho Dlamini"),
      lineBlock("Date: 2026-01-14"),
      lineBlock("Full Blood Count"),
      lineBlock("Specimen collected"),
      lineBlock("Reference range provided"),
      lineBlock("Pathologist: Dr Smith"),
    ];
    mockSend.mockResolvedValue({ Blocks: labBlocks });

    const result = await processDocument({
      userId: testUserId,
      documentId,
      bucket: "test-bucket",
      key: "test/lab.pdf",
      mimeType: "application/pdf",
    });

    // Return value checks
    expect(result.docType).toBe("lab");
    expect(result.documentReference.resourceType).toBe("DocumentReference");
    expect(result.documentReference.status).toBe("current");
    expect(result.extractedDate).toBe("2026-01-14");
    expect(result.facilityName).toBeTruthy();

    // Documents row updated
    const docRow = await pool.query<{ ocr_status: string; doc_type: string; full_text_raw: string }>(
      `SELECT ocr_status, doc_type, full_text_raw FROM documents WHERE id = $1`,
      [documentId],
    );
    expect(docRow.rows[0].ocr_status).toBe("complete");
    expect(docRow.rows[0].doc_type).toBe("lab");
    expect(docRow.rows[0].full_text_raw).toContain("Laboratory Medicine");

    // audit_log row inserted
    const logRow = await pool.query<{ action: string; details: Record<string, unknown> }>(
      `SELECT action, details FROM audit_log
       WHERE actor_id = $1 AND action = 'ocr.classify'
       ORDER BY occurred_at DESC LIMIT 1`,
      [testUserId],
    );
    expect(logRow.rowCount).toBe(1);
    const details = logRow.rows[0].details;
    expect(details.document_class).toBe("lab");
    expect(details.sahpra_class).toBe("A");
    expect(details.classifier_version_sha256).toBe(CLASSIFIER_VERSION_SHA256);
    expect(Array.isArray(details.NOT_extracted)).toBe(true);
    const notExtracted = details.NOT_extracted as string[];
    expect(notExtracted).toContain("clinical_values");
    expect(notExtracted).toContain("abnormal_flags");
    expect(notExtracted).toContain("medication_lists");
    expect(notExtracted).toContain("clinical_interpretation");
  });
});

describe("processDocument — compliance: patient_name not in DocumentReference description", () => {
  it("description contains facility and date but not patient name", async () => {
    const documentId = await createTestDocument();
    mockSend.mockResolvedValue({
      Blocks: [
        lineBlock("Khayelitsha Hospital"),
        lineBlock("Patient Name: Jane Nkosi"),
        lineBlock("Date: 2026-03-01"),
        lineBlock("Full Blood Count"),
        lineBlock("Specimen"),
        lineBlock("Reference range"),
      ],
    });

    const result = await processDocument({
      userId: testUserId,
      documentId,
      bucket: "test-bucket",
      key: "test/lab2.pdf",
      mimeType: "application/pdf",
    });

    expect(result.patientName).toBe("Jane Nkosi");
    // Patient name must NOT appear in the FHIR description field
    expect(result.documentReference.description ?? "").not.toContain("Jane Nkosi");
  });
});

describe("processDocument — compliance: KEY_VALUE_SET blocks discarded", () => {
  it("kv_blocks_discarded is recorded in audit_log; full text built from LINE blocks only", async () => {
    const documentId = await createTestDocument();
    const lineText = "Prescription\ntablet\nPharmacy: TestPharm\nRepeat x1";
    mockSend.mockResolvedValue({
      Blocks: [
        lineBlock("Prescription"),
        lineBlock("tablet"),
        lineBlock("Pharmacy: TestPharm"),
        lineBlock("Repeat x1"),
        kvBlock(),  // should be discarded
        kvBlock(),  // should be discarded
      ],
    });

    await processDocument({
      userId: testUserId,
      documentId,
      bucket: "test-bucket",
      key: "test/rx.pdf",
      mimeType: "application/pdf",
    });

    const logRow = await pool.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log
       WHERE actor_id = $1 AND action = 'ocr.classify'
       ORDER BY occurred_at DESC LIMIT 1`,
      [testUserId],
    );
    const details = logRow.rows[0].details;
    expect(details.kv_blocks_discarded).toBe(2);
    expect(details.textract_block_count).toBe(6); // all blocks counted
    const extracted = details.extracted as { full_text_chars: number };
    // Only LINE block text contributed — length of lineText
    expect(extracted.full_text_chars).toBe(lineText.length);
  });
});

describe("processDocument — compliance: 'Increase dose to 20mg' not in DR or audit extracted", () => {
  it("medication instruction text does not appear in structured fields", async () => {
    const documentId = await createTestDocument();
    mockSend.mockResolvedValue({
      Blocks: [
        lineBlock("Increase dose to 20mg daily"),
        lineBlock("As instructed by your doctor"),
      ],
    });

    const result = await processDocument({
      userId: testUserId,
      documentId,
      bucket: "test-bucket",
      key: "test/note.pdf",
      mimeType: "application/pdf",
    });

    const drStr = JSON.stringify(result.documentReference);
    expect(drStr).not.toContain("20mg");

    const logRow = await pool.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log
       WHERE actor_id = $1 AND action = 'ocr.classify'
       ORDER BY occurred_at DESC LIMIT 1`,
      [testUserId],
    );
    const extracted = logRow.rows[0].details.extracted as Record<string, unknown>;
    // Extracted fields are: doc_date, facility_name, patient_name, full_text_chars
    // None should contain the medication instruction
    expect(String(extracted.facility_name ?? "")).not.toContain("20mg");
    expect(String(extracted.patient_name ?? "")).not.toContain("20mg");
  });
});

describe("processDocument — compliance: Cardiomegaly not extracted as diagnosis", () => {
  it("Cardiomegaly term appears in full text but not in any structured output field", async () => {
    const documentId = await createTestDocument();
    mockSend.mockResolvedValue({
      Blocks: [
        lineBlock("Radiology Report"),
        lineBlock("Chest X-Ray"),
        lineBlock("Findings: Cardiomegaly noted"),
        lineBlock("Impression: see report"),
        lineBlock("Radiologist: Dr Adams"),
      ],
    });

    const result = await processDocument({
      userId: testUserId,
      documentId,
      bucket: "test-bucket",
      key: "test/cxr.pdf",
      mimeType: "application/pdf",
    });

    expect(result.docType).toBe("imaging");
    const drStr = JSON.stringify(result.documentReference);
    // Must not appear in any DocumentReference structured field
    expect(drStr.toLowerCase()).not.toMatch(/"(?:type|code|valueString|diagnosis)"\s*:\s*"[^"]*cardiomegaly/i);
    // Specifically no extension or code carrying the diagnosis
    expect(result.documentReference.type?.text).not.toContain("ardiomegaly");

    const logRow = await pool.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log
       WHERE actor_id = $1 AND action = 'ocr.classify'
       ORDER BY occurred_at DESC LIMIT 1`,
      [testUserId],
    );
    const extracted = logRow.rows[0].details.extracted as Record<string, unknown>;
    expect(String(extracted.facility_name ?? "")).not.toContain("ardiomegaly");
    expect(String(extracted.patient_name ?? "")).not.toContain("ardiomegaly");
  });
});

describe("processDocument — audit_log produced exactly once per call", () => {
  it("each processDocument call inserts exactly one audit_log row", async () => {
    const documentId = await createTestDocument();
    mockSend.mockResolvedValue({
      Blocks: [
        lineBlock("Test Laboratory"),
        lineBlock("Specimen report"),
        lineBlock("Reference range"),
      ],
    });

    const countBefore = await pool.query<{ n: number }>(
      `SELECT count(*)::int as n FROM audit_log WHERE actor_id = $1 AND action = 'ocr.classify'`,
      [testUserId],
    );

    await processDocument({
      userId: testUserId,
      documentId,
      bucket: "test-bucket",
      key: "test/once.pdf",
      mimeType: "application/pdf",
    });

    const countAfter = await pool.query<{ n: number }>(
      `SELECT count(*)::int as n FROM audit_log WHERE actor_id = $1 AND action = 'ocr.classify'`,
      [testUserId],
    );

    expect(countAfter.rows[0].n - countBefore.rows[0].n).toBe(1);
  });
});
