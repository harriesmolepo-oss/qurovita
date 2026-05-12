# Start Here — QuroVita Claude Code Setup

## For the human (you)

1. **Unzip `qurovita-today.zip`** into a folder (e.g. `C:\dev\qurovita`).
2. **Drop these three files into that folder:**
   - `CLAUDE.md`
   - `BUILD_PLAN.md`
   - `PROGRESS.md`
3. **Drop the master doc in too** — `QuroVita_Master_Document_v2.docx` from your project. Claude Code can read it for context.
4. **Open PowerShell** in that folder.
5. **Confirm Docker is running** (`docker ps`).
6. **Start Claude Code:**
   ```
   claude
   ```
7. **First prompt to Claude Code, exactly:**

   > Read CLAUDE.md, BUILD_PLAN.md, PROGRESS.md, and QuroVita_Master_Document_v2.docx. Then verify the v0 demo still works: run `docker compose up -d`, then in `backend/` run `npm install && npm run migrate && npm run dev`. Confirm http://localhost:3000/patient and http://localhost:3000/provider load. Once verified, begin task T0.1 from BUILD_PLAN.md. Pause for my confirmation before moving to T0.2.

8. **Watch what it does.** Approve commands when it asks. After T0.1 finishes, say "continue" or hand-pick the next task. Don't let it run wild — for the legal-stakes pieces (OCR, AI, crypto) review the diffs personally before approving the commit.

## What Claude Code will do

It will read CLAUDE.md as project context (it does this automatically), then work through BUILD_PLAN.md one task at a time, committing per task, running tests, and pausing for human input where the plan says `🔴 HUMAN ACTION NEEDED`.

## What Claude Code will not do

- Sign contracts (NGO MOU, Smile ID Operator agreement, attorney engagement)
- Register companies (CIPC, trademark, Information Officer)
- Apply for grants (NRF, DSTI) — though it can draft applications
- Make API account creations that need a credit card or phone verification
- Pay for anything
- Modify the AI system prompt or compliance regex without your explicit approval
- Skip tests or compliance audit log writes

These are flagged with `🔴 HUMAN ACTION NEEDED` in the build plan. Do them in parallel with the code work.

## Budget guard

API/cloud spend during build (not the SA team budget — just what Claude Code burns):

- Anthropic API for the build itself: estimate $40-150 over 12 weeks of dev (Claude Code uses Claude, you pay tokens)
- AWS af-south-1 dev account: ~R500-1,500/month while building
- Supabase Pro: $25/month from when Phase 1 starts
- Twilio: $0 until you provision the WhatsApp number (T5.2)
- Smile ID: $0 until you sign the Operator agreement (T5.1)
- Sentry/Datadog: free tier until production

Set a CloudWatch billing alarm at $50 and $100 to catch surprises.

## When things go wrong

If Claude Code:
- **Edits the AI system prompt without asking** → revert the commit, paste CLAUDE.md § HPCSA at it again, ask it to acknowledge before retrying.
- **Stores a clinical value field anywhere** → revert immediately. This is a Class A killer. Tell it to re-read CLAUDE.md § SAHPRA.
- **Tries to put a FHIR bundle into a QR code** → revert. CLAUDE.md § Architecture.
- **Deploys anything to a region that isn't `af-south-1`** → revert. POPIA breach.
- **Disables a test to make the suite green** → revert. The test was probably catching a real bug.

You are the regulatory backstop, not Claude Code. Trust but verify, especially on the OCR, AI, and crypto code paths.
