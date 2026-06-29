# Excel Import — Design Document

## 1. Overview

This feature allows a manager to upload an Excel file (.xlsx / .xls) containing employee information, preview the detected column mapping, confirm or adjust it, and bulk-import the records into the database. It is designed to onboard new employees quickly without relying on the chat agent or the per-row manual form.

---

## 2. User Flow

```
1. Manager clicks [⬆ Import Excel] button in the header
2. File picker opens → manager selects an .xlsx file
3. Backend parses the file and returns a column-preview payload
4. Frontend renders a mapping UI:
     Excel column  →  DB field  (dropdown, auto-suggested)
5. Manager adjusts mappings if needed, then clicks [Import]
6. Backend bulk-inserts records, returns a result summary
7. Frontend shows success/error toast; Gantt refreshes
```

---

## 3. Excel Format

The importer is intentionally flexible — it does not require a fixed column order or exact header names. Headers are matched by fuzzy keyword lookup (case-insensitive).

### Supported columns

| DB Field | Recognised header keywords | Required |
|---|---|---|
| `name` | name, 姓名, 员工姓名, full name | Yes |
| `email` | email, mail, 邮箱, e-mail | Yes |
| `seniority` | seniority, level, grade, 级别, 职级 | No (default: T1) |
| `skills` | skills, skill, 技能, technologies, tech | No |

### Skills column format

The skills column may contain a comma- or semicolon-separated list of skill names with optional proficiency levels:

```
React:4, Node.js:3, SAP CAP:2
React, Node.js, SAP CAP          ← level defaults to 3
```

Skills not already in the `Skills` table are created automatically.

### Sample Excel

| Name | Email | Level | Skills |
|---|---|---|---|
| Zhang Wei | zhang.wei@company.com | T3 | React:4, Node.js:3 |
| Li Na | li.na@company.com | T2 | Vue:3, CSS:4 |

---

## 4. Architecture

```
Browser
  │
  ├─ POST /data/import/preview   ← multipart/form-data (Excel file)
  │      → { columns, sampleRows, suggestedMapping }
  │
  └─ POST /data/import/execute   ← JSON { mapping, fileToken }
         → { created, updated, skipped, errors[] }
```

The two-step approach separates parsing from writing: the first call is safe to retry, the second is the commit.

---

## 5. Backend

### 5.1 New dependency

```json
"xlsx": "^0.18.5"
```

`xlsx` (SheetJS) is a zero-dependency Excel parser available on npm. It handles both `.xlsx` and `.xls` formats.

### 5.2 `/data/import/preview` — POST

Accepts `multipart/form-data` with a single field `file`.

**Processing steps:**
1. Parse the uploaded file with `xlsx.read(buffer, { type: 'buffer' })`
2. Read the first sheet; extract headers (row 0) and up to 5 sample rows
3. Run fuzzy matching against the known keyword table to suggest a mapping
4. Cache the parsed rows in memory under a short-lived `fileToken` (UUID, TTL 10 min)
5. Return preview payload

**Response:**
```json
{
  "fileToken": "abc-123",
  "columns": ["Name", "Email", "Level", "Skills"],
  "sampleRows": [
    ["Zhang Wei", "zhang.wei@company.com", "T3", "React:4, Node.js:3"]
  ],
  "suggestedMapping": {
    "Name":   "name",
    "Email":  "email",
    "Level":  "seniority",
    "Skills": "skills"
  }
}
```

### 5.3 `/data/import/execute` — POST

Accepts JSON body `{ fileToken, mapping }`.

**`mapping` format:**
```json
{
  "Name":   "name",
  "Email":  "email",
  "Level":  "seniority",
  "Skills": "skills"
}
```

**Processing steps:**
1. Retrieve cached rows by `fileToken`; return 404 if expired
2. For each row:
   a. Extract fields using `mapping`
   b. Validate `name` and `email` are non-empty
   c. Normalise `seniority` (accept `T1`–`T4`; also map `1`→`T1` etc.; default `T1`)
   d. Check if an employee with the same email already exists:
      - If yes: **update** name and seniority (email is the dedup key)
      - If no: **create** with a new ID (`e${Date.now()}${index}`)
   e. Parse skills string → `[{ name, level }]` array
   f. For each skill: upsert into `Skills`; upsert into `EmployeeSkills`
3. Collect per-row outcomes into `created`, `updated`, `skipped`, `errors`
4. Return summary

**Response:**
```json
{
  "created": 18,
  "updated": 3,
  "skipped": 0,
  "errors": [
    { "row": 5, "reason": "Missing email" }
  ]
}
```

**Error strategy:** row-level errors do not abort the batch. All valid rows are committed; invalid rows are collected and reported.

### 5.4 In-memory file cache

A plain `Map<token, { rows, expiresAt }>` is sufficient for the single-server dev context. A sweep runs every 5 minutes to evict expired entries.

```js
const fileCache = new Map();
// set:  fileCache.set(token, { rows, expiresAt: Date.now() + 10 * 60 * 1000 })
// get:  fileCache.get(token)
// sweep: setInterval(() => { for (const [k,v] of fileCache) if (v.expiresAt < Date.now()) fileCache.delete(k) }, 5 * 60 * 1000)
```

---

## 6. Frontend

### 6.1 New UI elements

The **Import Excel** button sits in the app header, to the left of the existing **⚙ Manage** button:

```
│  App Header: title │ [1M][2M][3M][6M]  [⬆ Import Excel] [⚙ Manage] [↺ Refresh] │
```

Clicking it opens the **Import Modal** (same overlay pattern as the Manage modal).

### 6.2 Import Modal — Step 1: Upload

```
┌──────────────────────────────────────────────┐
│  Import Employees from Excel                  │
│                                               │
│  ┌──────────────────────────────────────┐    │
│  │  Drag & drop .xlsx file here         │    │
│  │  or  [Browse file]                   │    │
│  └──────────────────────────────────────┘    │
│                                               │
│  [Cancel]                                     │
└──────────────────────────────────────────────┘
```

On file selection, immediately `POST /data/import/preview` and advance to Step 2.

### 6.3 Import Modal — Step 2: Column Mapping

```
┌──────────────────────────────────────────────┐
│  Map columns                                  │
│                                               │
│  Excel column    →  Field                     │
│  ─────────────────────────────────────────   │
│  Name            →  [Employee Name     ▼]    │
│  Email           →  [Email             ▼]    │
│  Level           →  [Seniority         ▼]    │
│  Skills          →  [Skills            ▼]    │
│                                               │
│  Preview (first 3 rows):                      │
│  ┌──────────────────────────────────────┐    │
│  │ Zhang Wei │ zhang.wei@… │ T3 │ React │    │
│  │ Li Na     │ li.na@…    │ T2 │ Vue   │    │
│  └──────────────────────────────────────┘    │
│                                               │
│  [Back]                         [Import ▶]   │
└──────────────────────────────────────────────┘
```

Dropdown options: `Employee Name`, `Email`, `Seniority`, `Skills`, `(ignore)`.

### 6.4 Import Modal — Step 3: Result

```
┌──────────────────────────────────────────────┐
│  Import complete                              │
│                                               │
│  ✓  21 employees imported                    │
│     18 created · 3 updated · 0 skipped       │
│                                               │
│  ⚠  2 rows had errors:                       │
│     Row 5 — Missing email                    │
│     Row 12 — Unknown seniority "Senior"      │
│                                               │
│  [Close]                                      │
└──────────────────────────────────────────────┘
```

On **Close**, `loadAll()` is called to refresh the Gantt.

### 6.5 Implementation notes

- The modal is a `<div id="importModal">` following the same pattern as `#manageModal`
- File parsing happens server-side; the frontend only handles the multipart upload and renders the JSON response
- No additional JS libraries are needed in the browser

---

## 7. Validation Rules

| Check | Behaviour on failure |
|---|---|
| `name` is empty | Skip row, log error |
| `email` is empty | Skip row, log error |
| `email` format invalid (no `@`) | Skip row, log error |
| `seniority` not in T1–T4 | Coerce if mappable, else default to T1 |
| Skill name exceeds 50 chars | Truncate to 50 |
| Skill level not 1–5 | Clamp to nearest bound |
| No required columns mapped | Return 400 before execution |

---

## 8. Seniority Normalisation

The importer accepts loose seniority inputs and maps them to the canonical `T1`–`T4` values:

| Input (case-insensitive) | Mapped to |
|---|---|
| T1, 1, junior, entry | T1 |
| T2, 2 | T2 |
| T3, 3, mid, intermediate | T3 |
| T4, 4, senior, expert, lead | T4 |
| anything else | T1 (default) |

---

## 9. New REST Endpoints Summary

| Method | Path | Purpose |
|---|---|---|
| POST | `/data/import/preview` | Parse Excel, return column preview + fileToken |
| POST | `/data/import/execute` | Bulk-import rows using confirmed mapping |

These join the existing custom REST table in §4.2 of the main design document.

---

## 10. Implementation Checklist

- [ ] Add `xlsx` to `package.json`
- [ ] Add `multipart/form-data` parser (`multer` or `busboy`) to `server.js`
- [ ] Implement `POST /data/import/preview` in `server.js`
- [ ] Implement `POST /data/import/execute` in `server.js`
- [ ] Add in-memory file cache with TTL sweep
- [ ] Add `[⬆ Import Excel]` button to `index.html` header
- [ ] Add Import Modal HTML (3 steps, same overlay pattern as Manage modal)
- [ ] Wire upload → preview → mapping → execute flow in `Main.controller.js`
- [ ] Add result display + `loadAll()` call on close
- [ ] Test with: clean file, missing columns, duplicate emails, malformed skills
