# Excel Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow managers to upload an Excel file and bulk-import employees (with skills) via a 3-step modal UI (upload → column mapping → result summary).

**Architecture:** Two-step backend (preview endpoint returns a fileToken + column info cached in memory; execute endpoint consumes the token and upserts employees/skills). Frontend adds an Import modal to `index.html` following the same overlay pattern as the existing Manage modal. All logic lives in `server.js` (backend) and inline `<script>` in `index.html` (frontend) — no new files needed.

**Tech Stack:** `multer` (multipart upload), `xlsx` / SheetJS (Excel parsing), vanilla JS + existing modal CSS, SAP CAP CDS queries.

---

## File Map

| File | Change |
|---|---|
| `package.json` | Add `multer` and `xlsx` dependencies |
| `server.js` | Add file cache, `/data/import/preview`, `/data/import/execute` routes |
| `app/resource-ui/webapp/index.html` | Add Import button to header + Import Modal HTML + JS controller |

---

### Task 1: Add dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add `multer` and `xlsx` to dependencies**

In `package.json`, change the `dependencies` block:

```json
"dependencies": {
  "@sap/cds": "^9",
  "@anthropic-ai/sdk": "^0.39.0",
  "express": "^4",
  "multer": "^1.4.5-lts.1",
  "xlsx": "^0.18.5"
},
```

- [ ] **Step 2: Install**

```bash
npm install
```

Expected: `added N packages` with no errors. `node_modules/multer` and `node_modules/xlsx` now exist.

---

### Task 2: Add in-memory file cache to `server.js`

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add the file cache and sweep just before `cds.on('bootstrap', ...)`**

Add this block at the top of `server.js`, after the `require` lines:

```js
const cds = require('@sap/cds');
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');

// In-memory cache for parsed Excel rows, keyed by fileToken (UUID), TTL 10 min
const fileCache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of fileCache) {
    if (v.expiresAt < now) fileCache.delete(k);
  }
}, 5 * 60 * 1000);

function makeid() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
```

> Note: `server.js` currently starts with `const cds = require('@sap/cds');` and `const express = require('express');`. Replace those two lines with the full block above.

- [ ] **Step 2: Verify server still starts**

```bash
npm run dev
```

Expected: `[server.js] routes registered` in console. Stop with Ctrl-C.

---

### Task 3: Implement `/data/import/preview`

**Files:**
- Modify: `server.js`

The keyword table for fuzzy column matching:

```js
const FIELD_KEYWORDS = {
  name:      ['name', '姓名', '员工姓名', 'full name', 'fullname'],
  email:     ['email', 'mail', '邮箱', 'e-mail'],
  seniority: ['seniority', 'level', 'grade', '级别', '职级'],
  skills:    ['skills', 'skill', '技能', 'technologies', 'tech'],
};
```

- [ ] **Step 1: Add `multer` upload middleware and the preview route inside `cds.on('bootstrap', app => { ... })`**

Add after the `app.use(express.json())` line:

```js
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

  const FIELD_KEYWORDS = {
    name:      ['name', '姓名', '员工姓名', 'full name', 'fullname'],
    email:     ['email', 'mail', '邮箱', 'e-mail'],
    seniority: ['seniority', 'level', 'grade', '级别', '职级'],
    skills:    ['skills', 'skill', '技能', 'technologies', 'tech'],
  };

  function suggestField(header) {
    const h = header.toLowerCase();
    for (const [field, keywords] of Object.entries(FIELD_KEYWORDS)) {
      if (keywords.some(kw => h.includes(kw))) return field;
    }
    return null;
  }

  app.post('/data/import/preview', upload.single('file'), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      if (!rows.length) return res.status(400).json({ error: 'Empty spreadsheet' });

      const headers = rows[0].map(String);
      const sampleRows = rows.slice(1, 6).map(r => headers.map((_, i) => String(r[i] ?? '')));

      const suggestedMapping = {};
      headers.forEach(h => { suggestedMapping[h] = suggestField(h); });

      const token = makeid();
      fileCache.set(token, { rows: rows.slice(1), headers, expiresAt: Date.now() + 10 * 60 * 1000 });

      res.json({ fileToken: token, columns: headers, sampleRows, suggestedMapping });
    } catch (err) {
      console.error('Import preview error:', err);
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 2: Smoke-test with curl**

```bash
# Create a tiny test xlsx first
node -e "
const XLSX = require('xlsx');
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Name','Email','Level','Skills'],['Test User','test@example.com','T2','React:3']]), 'Sheet1');
XLSX.writeFile(wb, '/tmp/test.xlsx');
console.log('written');
"
curl -s -F "file=@/tmp/test.xlsx" http://localhost:4004/data/import/preview | node -e "process.stdin.on('data',d=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
```

Expected output (abbreviated):
```json
{
  "fileToken": "<some token>",
  "columns": ["Name", "Email", "Level", "Skills"],
  "sampleRows": [["Test User", "test@example.com", "T2", "React:3"]],
  "suggestedMapping": { "Name": "name", "Email": "email", "Level": "seniority", "Skills": "skills" }
}
```

---

### Task 4: Implement `/data/import/execute`

**Files:**
- Modify: `server.js`

Seniority normalisation map and skills parser used inside the execute handler:

```js
const SENIORITY_MAP = {
  t1: 'T1', '1': 'T1', junior: 'T1', entry: 'T1',
  t2: 'T2', '2': 'T2',
  t3: 'T3', '3': 'T3', mid: 'T3', intermediate: 'T3',
  t4: 'T4', '4': 'T4', senior: 'T4', expert: 'T4', lead: 'T4',
};

function normaliseSeniority(raw) {
  if (!raw) return 'T1';
  return SENIORITY_MAP[String(raw).trim().toLowerCase()] || 'T1';
}

function parseSkills(raw) {
  if (!raw) return [];
  return String(raw).split(/[,;]/).map(s => s.trim()).filter(Boolean).map(s => {
    const [name, level] = s.split(':');
    const lvl = parseInt(level);
    return { name: name.trim().slice(0, 50), level: isNaN(lvl) ? 3 : Math.min(5, Math.max(1, lvl)) };
  });
}
```

- [ ] **Step 1: Add `SENIORITY_MAP`, `normaliseSeniority`, `parseSkills` helpers and the execute route**

Add directly after the preview route:

```js
  const SENIORITY_MAP = {
    t1: 'T1', '1': 'T1', junior: 'T1', entry: 'T1',
    t2: 'T2', '2': 'T2',
    t3: 'T3', '3': 'T3', mid: 'T3', intermediate: 'T3',
    t4: 'T4', '4': 'T4', senior: 'T4', expert: 'T4', lead: 'T4',
  };

  function normaliseSeniority(raw) {
    if (!raw) return 'T1';
    return SENIORITY_MAP[String(raw).trim().toLowerCase()] || 'T1';
  }

  function parseSkills(raw) {
    if (!raw) return [];
    return String(raw).split(/[,;]/).map(s => s.trim()).filter(Boolean).map(s => {
      const [namePart, levelPart] = s.split(':');
      const lvl = parseInt(levelPart);
      return { name: namePart.trim().slice(0, 50), level: isNaN(lvl) ? 3 : Math.min(5, Math.max(1, lvl)) };
    });
  }

  app.post('/data/import/execute', async (req, res) => {
    try {
      const { fileToken, mapping } = req.body;
      if (!fileToken || !mapping) return res.status(400).json({ error: 'fileToken and mapping are required' });

      const cached = fileCache.get(fileToken);
      if (!cached) return res.status(404).json({ error: 'File token expired or not found. Please re-upload.' });

      const { rows, headers } = cached;

      // Validate that required fields are mapped
      const mappedFields = Object.values(mapping).filter(Boolean);
      if (!mappedFields.includes('name') || !mappedFields.includes('email')) {
        return res.status(400).json({ error: 'Mapping must include at least "name" and "email" columns.' });
      }

      const colIndex = {};
      headers.forEach((h, i) => { if (mapping[h]) colIndex[mapping[h]] = i; });

      let created = 0, updated = 0, skipped = 0;
      const errors = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2; // 1-indexed, +1 for header row
        const name  = String(row[colIndex.name]  ?? '').trim();
        const email = String(row[colIndex.email] ?? '').trim();

        if (!name)  { errors.push({ row: rowNum, reason: 'Missing name' });  skipped++; continue; }
        if (!email) { errors.push({ row: rowNum, reason: 'Missing email' }); skipped++; continue; }
        if (!email.includes('@')) { errors.push({ row: rowNum, reason: 'Invalid email (no @)' }); skipped++; continue; }

        const seniority = normaliseSeniority(row[colIndex.seniority] ?? '');
        const skillsRaw = colIndex.skills !== undefined ? row[colIndex.skills] : '';
        const skillsList = parseSkills(skillsRaw);

        // Upsert employee by email
        const existing = await SELECT.one.from('resourceagent.Employees').where({ email });
        let empId;
        if (existing) {
          await UPDATE('resourceagent.Employees').set({ name, seniority }).where({ email });
          empId = existing.ID;
          updated++;
        } else {
          empId = 'e' + Date.now() + i;
          await INSERT.into('resourceagent.Employees').entries({ ID: empId, name, email, seniority });
          created++;
        }

        // Upsert skills
        for (const sk of skillsList) {
          let skillRow = await SELECT.one.from('resourceagent.Skills').where({ name: sk.name });
          if (!skillRow) {
            const skillId = 's' + Date.now() + Math.random().toString(36).slice(2);
            await INSERT.into('resourceagent.Skills').entries({ ID: skillId, name: sk.name });
            skillRow = { ID: skillId };
          }
          const existingES = await SELECT.one.from('resourceagent.EmployeeSkills')
            .where({ employeeId: empId, skillId: skillRow.ID });
          if (existingES) {
            await UPDATE('resourceagent.EmployeeSkills').set({ level: sk.level })
              .where({ employeeId: empId, skillId: skillRow.ID });
          } else {
            await INSERT.into('resourceagent.EmployeeSkills')
              .entries({ employeeId: empId, skillId: skillRow.ID, level: sk.level });
          }
        }
      }

      res.json({ created, updated, skipped, errors });
    } catch (err) {
      console.error('Import execute error:', err);
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 2: Test end-to-end with curl**

```bash
# 1. Upload for preview (reuse test.xlsx from Task 3)
TOKEN=$(curl -s -F "file=@/tmp/test.xlsx" http://localhost:4004/data/import/preview | node -e "let d='';process.stdin.on('data',x=>d+=x).on('end',()=>console.log(JSON.parse(d).fileToken))")
echo "Token: $TOKEN"

# 2. Execute import
curl -s -X POST http://localhost:4004/data/import/execute \
  -H "Content-Type: application/json" \
  -d "{\"fileToken\":\"$TOKEN\",\"mapping\":{\"Name\":\"name\",\"Email\":\"email\",\"Level\":\"seniority\",\"Skills\":\"skills\"}}" \
  | node -e "process.stdin.on('data',d=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
```

Expected:
```json
{ "created": 1, "updated": 0, "skipped": 0, "errors": [] }
```

Running a second time with the same file should produce:
```json
{ "created": 0, "updated": 1, "skipped": 0, "errors": [] }
```

---

### Task 5: Add Import button to the HTML header

**Files:**
- Modify: `app/resource-ui/webapp/index.html`

- [ ] **Step 1: Add the Import Excel button to the header `headerActions` div**

Find this block in `index.html`:

```html
      <button class="btnHeader" onclick="openManage()">⚙ Manage</button>
      <button class="btnHeader" onclick="loadAll()">↺ Refresh</button>
```

Replace with:

```html
      <button class="btnHeader" onclick="openImport()">⬆ Import Excel</button>
      <button class="btnHeader" onclick="openManage()">⚙ Manage</button>
      <button class="btnHeader" onclick="loadAll()">↺ Refresh</button>
```

- [ ] **Step 2: Verify the button appears**

Open `http://localhost:4004/resource-ui/webapp/index.html`. The header should show `⬆ Import Excel` to the left of `⚙ Manage`. Clicking it will error (function not yet defined) — that is expected at this step.

---

### Task 6: Add Import Modal HTML

**Files:**
- Modify: `app/resource-ui/webapp/index.html`

- [ ] **Step 1: Add Import Modal markup after the closing `</div>` of `<!-- ── Record Form Modal ── -->`**

After `</div>` that closes `formModal`, add:

```html
  <!-- ── Import Modal ── -->
  <div class="modal" id="importModal">
    <div class="modalBox" style="width:620px">
      <div class="modalHeader">
        <span class="modalTitle" id="importModalTitle">Import Employees from Excel</span>
        <button class="modalClose" onclick="closeImport()">×</button>
      </div>
      <div class="modalBody" id="importModalBody">
        <!-- Populated by JS -->
      </div>
    </div>
  </div>
```

- [ ] **Step 2: Add the Import Modal CSS styles** in the second `<style>` block (blue-yellow theme), at the end before the closing `</style>`:

```css
    /* Import Modal */
    .importDropZone {
      border: 2px dashed var(--border);
      border-radius: 10px;
      padding: 36px 24px;
      text-align: center;
      color: var(--muted);
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
      background: var(--mist);
    }
    .importDropZone:hover, .importDropZone.drag-over {
      border-color: var(--navy);
      background: #daeaf8;
    }
    .importDropZone p { margin: 8px 0 0; font-size: 13px; }
    .importMappingTable { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
    .importMappingTable th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); padding: 6px 10px; background: var(--mist); border-bottom: 2px solid var(--border); text-align: left; }
    .importMappingTable td { padding: 7px 10px; border-bottom: 1px solid var(--border); font-size: 13px; }
    .importPreviewTable { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 10px; }
    .importPreviewTable th { background: var(--mist); padding: 5px 8px; font-weight: 600; color: var(--muted); font-size: 11px; border-bottom: 1px solid var(--border); text-align: left; }
    .importPreviewTable td { padding: 4px 8px; border-bottom: 1px solid #f0f7ff; color: var(--text); }
    .importResult { text-align: center; padding: 20px 0; }
    .importResult .importCount { font-size: 28px; font-weight: 700; color: var(--navy); }
    .importResult .importBreakdown { font-size: 13px; color: var(--muted); margin: 4px 0 16px; }
    .importErrorList { max-height: 140px; overflow-y: auto; text-align: left; background: #fff8f0; border: 1px solid #f5e6d8; border-radius: 8px; padding: 10px 14px; font-size: 12px; color: #8a4a18; }
    .importErrorList li { margin: 3px 0; }
    .importFooter { display: flex; justify-content: space-between; align-items: center; padding: 14px 22px; border-top: 1.5px solid var(--border); background: var(--mist); border-radius: 0 0 12px 12px; }
```

---

### Task 7: Add Import Modal JavaScript

**Files:**
- Modify: `app/resource-ui/webapp/index.html`

Add the following JS block inside the existing `<script>` tag, just before the `// ── Init` comment line:

- [ ] **Step 1: Add import state variables and helper functions**

```js
    // ── Import Modal ──────────────────────────────────────────────────────────
    let importStep = 1;
    let importPreviewData = null; // { fileToken, columns, sampleRows, suggestedMapping }
    let importMapping = {};       // { colName: fieldName | null }

    const IMPORT_FIELD_LABELS = {
      name: 'Employee Name',
      email: 'Email',
      seniority: 'Seniority',
      skills: 'Skills',
    };

    function openImport() {
      importStep = 1;
      importPreviewData = null;
      importMapping = {};
      document.getElementById('importModal').classList.add('open');
      _renderImportStep1();
    }

    function closeImport() {
      document.getElementById('importModal').classList.remove('open');
    }
```

- [ ] **Step 2: Add Step 1 renderer (upload / drop zone)**

```js
    function _renderImportStep1() {
      document.getElementById('importModalTitle').textContent = 'Import Employees from Excel';
      document.getElementById('importModalBody').innerHTML = `
        <div style="padding:8px 0 16px">
          <div class="importDropZone" id="importDropZone" onclick="document.getElementById('importFileInput').click()"
            ondragover="event.preventDefault();this.classList.add('drag-over')"
            ondragleave="this.classList.remove('drag-over')"
            ondrop="event.preventDefault();this.classList.remove('drag-over');_handleImportFile(event.dataTransfer.files[0])">
            <div style="font-size:32px">📂</div>
            <p>Drag & drop an <strong>.xlsx</strong> file here</p>
            <p style="margin-top:10px"><button class="btnSecondary" style="pointer-events:none">Browse file</button></p>
          </div>
          <input type="file" id="importFileInput" accept=".xlsx,.xls" style="display:none"
            onchange="_handleImportFile(this.files[0])"/>
        </div>
        <div class="importFooter">
          <button class="btnSecondary" onclick="closeImport()">Cancel</button>
          <span></span>
        </div>`;
    }
```

- [ ] **Step 3: Add file upload handler and Step 2 renderer (column mapping)**

```js
    async function _handleImportFile(file) {
      if (!file) return;
      const zone = document.getElementById('importDropZone');
      if (zone) zone.innerHTML = '<div style="font-size:13px;color:var(--muted)">Uploading…</div>';

      const form = new FormData();
      form.append('file', file);
      try {
        const res = await fetch('/data/import/preview', { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) { alert('Preview failed: ' + data.error); _renderImportStep1(); return; }
        importPreviewData = data;
        importMapping = { ...data.suggestedMapping };
        _renderImportStep2();
      } catch (err) {
        alert('Upload error: ' + err.message);
        _renderImportStep1();
      }
    }

    function _renderImportStep2() {
      const { columns, sampleRows, suggestedMapping } = importPreviewData;
      document.getElementById('importModalTitle').textContent = 'Map columns';

      const fieldOptions = [
        '<option value="">(ignore)</option>',
        ...Object.entries(IMPORT_FIELD_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`)
      ].join('');

      const mappingRows = columns.map(col => {
        const suggested = suggestedMapping[col] || '';
        const opts = [
          '<option value="">(ignore)</option>',
          ...Object.entries(IMPORT_FIELD_LABELS).map(([v, l]) =>
            `<option value="${v}" ${suggested === v ? 'selected' : ''}>${l}</option>`)
        ].join('');
        return `<tr>
          <td style="font-weight:600">${escHtml(col)}</td>
          <td>→</td>
          <td><select class="formGroup" data-import-col="${escHtml(col)}" onchange="importMapping[this.dataset.importCol]=this.value||null" style="padding:5px 8px;border:1px solid var(--border);border-radius:5px;font-size:13px;background:var(--mist)">
            ${opts}
          </select></td>
        </tr>`;
      }).join('');

      const previewHeaders = columns.map(c => `<th>${escHtml(c)}</th>`).join('');
      const previewBodyRows = sampleRows.slice(0, 3).map(r =>
        `<tr>${r.map(cell => `<td>${escHtml(String(cell))}</td>`).join('')}</tr>`
      ).join('');

      document.getElementById('importModalBody').innerHTML = `
        <table class="importMappingTable">
          <thead><tr><th>Excel Column</th><th></th><th>Field</th></tr></thead>
          <tbody>${mappingRows}</tbody>
        </table>
        <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.4px">Preview (first 3 rows)</div>
        <div style="overflow-x:auto">
          <table class="importPreviewTable">
            <thead><tr>${previewHeaders}</tr></thead>
            <tbody>${previewBodyRows}</tbody>
          </table>
        </div>
        <div class="importFooter">
          <button class="btnSecondary" onclick="_renderImportStep1()">← Back</button>
          <button class="btnPrimary" onclick="_executeImport()">Import ▶</button>
        </div>`;
    }
```

- [ ] **Step 4: Add execute handler and Step 3 renderer (result)**

```js
    async function _executeImport() {
      const btn = document.querySelector('#importModalBody .btnPrimary');
      if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
      try {
        const res = await fetch('/data/import/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileToken: importPreviewData.fileToken, mapping: importMapping })
        });
        const data = await res.json();
        if (!res.ok) { alert('Import failed: ' + data.error); if (btn) { btn.disabled = false; btn.textContent = 'Import ▶'; } return; }
        _renderImportStep3(data);
      } catch (err) {
        alert('Import error: ' + err.message);
        if (btn) { btn.disabled = false; btn.textContent = 'Import ▶'; }
      }
    }

    function _renderImportStep3(result) {
      const { created, updated, skipped, errors } = result;
      const total = created + updated;
      document.getElementById('importModalTitle').textContent = 'Import complete';

      const errorSection = errors.length ? `
        <div style="margin-top:16px">
          <div style="font-size:13px;font-weight:600;color:#8a4a18;margin-bottom:6px">⚠ ${errors.length} row${errors.length > 1 ? 's' : ''} had errors:</div>
          <div class="importErrorList"><ul style="margin:0;padding-left:18px">
            ${errors.map(e => `<li>Row ${e.row} — ${escHtml(e.reason)}</li>`).join('')}
          </ul></div>
        </div>` : '';

      document.getElementById('importModalBody').innerHTML = `
        <div class="importResult">
          <div class="importCount">✓ ${total} employee${total !== 1 ? 's' : ''} imported</div>
          <div class="importBreakdown">${created} created · ${updated} updated · ${skipped} skipped</div>
          ${errorSection}
        </div>
        <div class="importFooter">
          <span></span>
          <button class="btnPrimary" onclick="closeImport();loadAll()">Close</button>
        </div>`;
    }
```

- [ ] **Step 5: Verify the full flow in the browser**

1. Start server: `npm run dev`
2. Open `http://localhost:4004/resource-ui/webapp/index.html`
3. Click `⬆ Import Excel` — modal opens showing drop zone
4. Upload `/tmp/test.xlsx` created in Task 3 — modal advances to mapping step with `Name→Employee Name`, `Email→Email`, `Level→Seniority`, `Skills→Skills` pre-selected
5. Click `Import ▶` — modal shows "✓ 1 employee imported, 1 created"
6. Click `Close` — Gantt refreshes
7. Upload same file again — result should show "0 created · 1 updated"

---

### Task 8: Edge-case validation tests

**Files:**
- No new files; test via curl against the running server

- [ ] **Step 1: Test missing required columns → 400**

```bash
# Upload a file with only a Name column, no Email
node -e "
const XLSX = require('xlsx');
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Name'],['Test User']]), 'Sheet1');
XLSX.writeFile(wb, '/tmp/no_email.xlsx');
"
TOKEN=$(curl -s -F "file=@/tmp/no_email.xlsx" http://localhost:4004/data/import/preview | node -e "let d='';process.stdin.on('data',x=>d+=x).on('end',()=>console.log(JSON.parse(d).fileToken))")
curl -s -X POST http://localhost:4004/data/import/execute \
  -H "Content-Type: application/json" \
  -d "{\"fileToken\":\"$TOKEN\",\"mapping\":{\"Name\":\"name\"}}" \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).error))"
```

Expected: `Mapping must include at least "name" and "email" columns.`

- [ ] **Step 2: Test rows with missing email → skipped with error**

```bash
node -e "
const XLSX = require('xlsx');
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Name','Email'],['Valid User','valid@test.com'],['No Email','']]), 'Sheet1');
XLSX.writeFile(wb, '/tmp/missing_email.xlsx');
"
TOKEN=$(curl -s -F "file=@/tmp/missing_email.xlsx" http://localhost:4004/data/import/preview | node -e "let d='';process.stdin.on('data',x=>d+=x).on('end',()=>console.log(JSON.parse(d).fileToken))")
curl -s -X POST http://localhost:4004/data/import/execute \
  -H "Content-Type: application/json" \
  -d "{\"fileToken\":\"$TOKEN\",\"mapping\":{\"Name\":\"name\",\"Email\":\"email\"}}" \
  | node -e "process.stdin.on('data',d=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
```

Expected:
```json
{ "created": 1, "updated": 0, "skipped": 1, "errors": [{ "row": 3, "reason": "Missing email" }] }
```

- [ ] **Step 3: Test expired token → 404**

```bash
curl -s -X POST http://localhost:4004/data/import/execute \
  -H "Content-Type: application/json" \
  -d '{"fileToken":"nonexistent","mapping":{"Name":"name","Email":"email"}}' \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).error))"
```

Expected: `File token expired or not found. Please re-upload.`

- [ ] **Step 4: Test seniority normalisation**

```bash
node -e "
const XLSX = require('xlsx');
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ['Name','Email','Level'],
  ['Senior Dev','senior@test.com','senior'],
  ['Junior Dev','junior@test.com','1'],
  ['Mid Dev','mid@test.com','mid'],
  ['Lead Dev','lead@test.com','lead'],
]), 'Sheet1');
XLSX.writeFile(wb, '/tmp/seniority.xlsx');
"
TOKEN=$(curl -s -F "file=@/tmp/seniority.xlsx" http://localhost:4004/data/import/preview | node -e "let d='';process.stdin.on('data',x=>d+=x).on('end',()=>console.log(JSON.parse(d).fileToken))")
curl -s -X POST http://localhost:4004/data/import/execute \
  -H "Content-Type: application/json" \
  -d "{\"fileToken\":\"$TOKEN\",\"mapping\":{\"Name\":\"name\",\"Email\":\"email\",\"Level\":\"seniority\"}}" \
  | node -e "process.stdin.on('data',d=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
# Then verify via OData:
curl -s "http://localhost:4004/api/Employees?\$filter=email eq 'senior@test.com'&\$select=name,seniority" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).value[0]?.seniority))"
```

Expected last output: `T4`

---

## Self-Review Checklist

- [x] **Task 1** — `multer` + `xlsx` added to `package.json`
- [x] **Task 2** — in-memory cache + sweep + `makeid()` added to `server.js`
- [x] **Task 3** — `POST /data/import/preview` with fuzzy column matching
- [x] **Task 4** — `POST /data/import/execute` with upsert logic, skill upsert, row-level errors
- [x] **Task 5** — `⬆ Import Excel` button in header
- [x] **Task 6** — Import Modal HTML + CSS
- [x] **Task 7** — Full JS controller: `openImport`, Step 1/2/3 renderers, `_handleImportFile`, `_executeImport`
- [x] **Task 8** — Edge-case curl tests: missing columns, missing email, expired token, seniority normalisation

**Spec coverage check:**
- File format: `.xlsx`/`.xls` ✓ (SheetJS handles both)
- Fuzzy keyword matching with Chinese keywords ✓ (`FIELD_KEYWORDS`)
- Skills format `React:4, Node.js:3` and bare `React` ✓ (`parseSkills`)
- Skills not in DB auto-created ✓ (upsert in execute handler)
- email dedup key ✓
- Row-level errors don't abort batch ✓
- 10-min TTL + 5-min sweep ✓
- fileToken two-step architecture ✓
- 3-step modal UI ✓
- `loadAll()` called on close ✓
- `[⬆ Import Excel]` left of `⚙ Manage` ✓
- Drag & drop + Browse ✓
- Seniority normalisation table fully covered ✓
- Validation: empty name/email, invalid email, no required mapping ✓
- Skill level clamped 1–5 ✓, skill name truncated to 50 ✓
