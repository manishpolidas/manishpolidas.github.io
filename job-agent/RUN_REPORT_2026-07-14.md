# Job-agent daily run — 2026-07-14

## Outcome in one line
30 postings discovered → 17 qualified (≥55) and logged → 8 fully tailored
(resume PDF + cover letter + screening answers) → **0 submitted**: the
sandbox's egress proxy blocks all connections to job sites (HTTP 403), so the
4 auto-submit-eligible applications are staged and logged `BLOCKED`.

## Why nothing was submitted
Every direct HTTPS fetch from this environment (curl and page-fetch alike)
returns a proxy 403 — only search-engine queries work. No application form can
even be loaded, let alone filled. Per the guardrails, no evasion was
attempted. Additionally, all four ≥70 targets (Deloitte USI, JPMC/Oracle,
Wipro/SuccessFactors, Cutshort) sit behind account-login walls, and no
credentials are available in this environment.

**To actually submit:** run this agent in an environment with open network
egress and portal credentials, or use the staged assets below for one-click
manual submission — each blocked row in the tracker links the exact posting
URL, resume PDF, and cover letter.

## Auto-submit bucket (score ≥ 70) — staged, BLOCKED
| App ID | Company | Role | Score |
|---|---|---|---|
| 2026-001 | Deloitte India (USI) | S/4HANA ABAP Consultant (RAP, CDS, OData) | 79 |
| 2026-002 | JPMorgan Chase | Software Engineer III – SAP ABAP (HANA, BTP) | 76 |
| 2026-003 | Wipro | SAP ABAP HANA Developer (5–8 yrs) | 73 |
| 2026-004 | BDI India | SAP ABAP Developer (remote-friendly) | 70 |

## NEEDS_REVIEW (55–69): 13 roles
Top of the band also got tailored assets: Siemens Senior CAP Developer (68),
SAP Labs Development Consultant (67), Schaeffler ABAP+Fiori full-stack (65),
Bosch SDS S/4HANA ABAP — Hyderabad (64). Notable flags: Accenture (67) is a
former-employer rehire decision; Agilent (64) is the best pure skill match but
sits in Manesar, Haryana; Onward Technologies (55) wants immediate joiners vs
the 60-day notice.

## Truthfulness skips (hard-skipped, not logged as applications)
SAP Basis (Infineon), HR/HCM-specific ABAP (Cognizant, Capgemini), IS-U/CRM
requiring an IS-U implementation (Bosch Bengaluru), PI/PO-hybrid (Kyndryl —
PI/PO iFlow development not in profile), NTT DATA (8+ yrs lead-only),
Lonza (10+ yrs lead-only).

## Company discovery (weekly pipeline)
7 new companies added to the Companies sheet, including Lonza GCC (Hyderabad,
Mar 2026), Sanofi GCC expansion (Hyderabad), Merck KGaA GCC (Bengaluru, Jun
2026 — flagship S/4HANA customer), CIBC (Hyderabad, Jul 2026), KLA (Chennai).
Western Union logged as not SAP-relevant.

## Caveats
- The repo contained no `main.tex`, so the canonical master was reconstructed
  from the operator profile + portfolio site. **Airbus bullets are synthesized
  from the profile's stated stack — Manish should review them before any
  submission.** Accenture bullets come from his own portfolio site.
- Because egress was blocked, postings were verified via search-indexed ATS
  pages, not live fetches (`verified:false` in discovery data). Re-check each
  URL is still open before submitting; two postings are >60 days old (noted).
- Standing answers used: expected CTC 21,00,000; notice 60 days; relocate yes.

## Files
- `job_applications.xlsx` — Applications (17), Summary, Companies (41), audit_log (14)
- `resumes/` — 8 tailored `.tex` + compiled one-page PDFs
- `cover_letters/` — 8 letters (≤180 words) each with a screening-answers block
- `main.tex` / `main.pdf` — canonical master; `changelogs.md` — per-version log
- `scorer.py`, `tracker.py`, `generate_tailored.py`, `tailor_config.json` — rerunnable pipeline
