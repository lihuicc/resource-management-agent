const cds = require('@sap/cds');
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');

// In-memory cache for parsed Excel rows, keyed by fileToken, TTL 10 min
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

cds.on('bootstrap', (app) => {
  app.use(express.json());

  // ── Excel Import ──────────────────────────────────────────────────────────
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

  const SENIORITY_MAP = {
    t1: 'T1', '1': 'T1', junior: 'T1', entry: 'T1',
    t2: 'T2', '2': 'T2',
    t3: 'T3', '3': 'T3', mid: 'T3', intermediate: 'T3',
    t4: 'T4', '4': 'T4', senior: 'T4', expert: 'T4', lead: 'T4',
  };

  function normaliseSeniority(raw) {
    if (!raw) return { value: 'T1', warning: null };
    const str = String(raw).trim();
    const mapped = SENIORITY_MAP[str.toLowerCase()];
    if (mapped) return { value: mapped, warning: null };
    // Keep T\d as-is but warn; anything else defaults to T1
    if (/^T\d+$/i.test(str)) return { value: str.toUpperCase(), warning: `Unrecognised seniority "${str}", kept as-is` };
    return { value: 'T1', warning: `Unrecognised seniority "${str}", defaulted to T1` };
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
        const rowNum = i + 2;
        const name  = String(row[colIndex.name]  ?? '').trim();
        const email = String(row[colIndex.email] ?? '').trim();

        if (!name)  { errors.push({ row: rowNum, reason: 'Missing name' });  skipped++; continue; }
        if (!email) { errors.push({ row: rowNum, reason: 'Missing email' }); skipped++; continue; }
        if (!email.includes('@')) { errors.push({ row: rowNum, reason: 'Invalid email (no @)' }); skipped++; continue; }

        const { value: seniority, warning: senWarning } = normaliseSeniority(row[colIndex.seniority] ?? '');
        if (senWarning) errors.push({ row: rowNum, reason: senWarning });
        const skillsRaw = colIndex.skills !== undefined ? row[colIndex.skills] : '';
        const skillsList = parseSkills(skillsRaw);

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

  // ── Export ────────────────────────────────────────────────────────────────
  app.get('/data/export/employees', async (_req, res) => {
    try {
      const [emps, allES, allSkills] = await Promise.all([
        SELECT.from('resourceagent.Employees').orderBy('name'),
        SELECT.from('resourceagent.EmployeeSkills'),
        SELECT.from('resourceagent.Skills'),
      ]);
      const skillById = Object.fromEntries(allSkills.map(s => [s.ID, s.name]));
      const skillsByEmp = {};
      allES.forEach(es => {
        if (!skillsByEmp[es.employeeId]) skillsByEmp[es.employeeId] = [];
        skillsByEmp[es.employeeId].push(`${skillById[es.skillId] || es.skillId}:${es.level}`);
      });

      const rows = [['Name', 'Email', 'Level', 'Skills']];
      emps.forEach(e => {
        rows.push([e.name, e.email, e.seniority, (skillsByEmp[e.ID] || []).join(', ')]);
      });

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Employees');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="employees.xlsx"');
      res.send(buf);
    } catch (err) {
      console.error('Export error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Agent chat ────────────────────────────────────────────────────────────
  app.post('/agent/chat', async (req, res) => {
    try {
      const { message, conversationHistory = [] } = req.body;
      if (!message) return res.status(400).json({ error: 'message is required' });
      const { runAgent } = require('./srv/agent-service');
      const result = await runAgent(message, conversationHistory);
      res.json({ reply: result.reply, toolsUsed: result.toolsUsed, messages: result.messages });
    } catch (err) {
      console.error('Agent error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Employees ─────────────────────────────────────────────────────────────
  app.post('/data/Employees', async (req, res) => {
    try {
      const { name, email, seniority } = req.body;
      const id = 'e' + Date.now();
      await INSERT.into('resourceagent.Employees').entries({ ID: id, name, email, seniority });
      res.json({ ID: id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.patch('/data/Employees/:id', async (req, res) => {
    try {
      const { name, email, seniority } = req.body;
      await UPDATE('resourceagent.Employees').set({ name, email, seniority }).where({ ID: req.params.id });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/data/Employees/:id', async (req, res) => {
    try {
      const id = req.params.id;
      await DELETE.from('resourceagent.EmployeeSkills').where({ employeeId: id });
      await DELETE.from('resourceagent.Assignments').where({ employeeId: id });
      await DELETE.from('resourceagent.Employees').where({ ID: id });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Employee Skills ───────────────────────────────────────────────────────
  app.post('/data/EmployeeSkills/:employeeId', async (req, res) => {
    try {
      const { employeeId } = req.params;
      const { skills } = req.body; // [{skillId, level}]
      await DELETE.from('resourceagent.EmployeeSkills').where({ employeeId });
      if (skills.length) {
        await INSERT.into('resourceagent.EmployeeSkills').entries(
          skills.map(s => ({ employeeId, skillId: s.skillId, level: s.level }))
        );
      }
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Projects ──────────────────────────────────────────────────────────────
  app.post('/data/Projects', async (req, res) => {
    try {
      const { name, description, startDate, endDate, status } = req.body;
      const id = 'p' + Date.now();
      await INSERT.into('resourceagent.Projects').entries({ ID: id, name, description: description || '', startDate, endDate, status });
      res.json({ ID: id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.patch('/data/Projects/:id', async (req, res) => {
    try {
      const { name, description, startDate, endDate, status } = req.body;
      const updates = {};
      if (name !== undefined)        updates.name        = name;
      if (description !== undefined) updates.description = description;
      if (startDate !== undefined)   updates.startDate   = startDate;
      if (endDate !== undefined)     updates.endDate     = endDate;
      if (status !== undefined)      updates.status      = status;
      await UPDATE('resourceagent.Projects').set(updates).where({ ID: req.params.id });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/data/Projects/:id', async (req, res) => {
    try {
      const id = req.params.id;
      await DELETE.from('resourceagent.Assignments').where({ projectId: id });
      await DELETE.from('resourceagent.ProjectSkills').where({ projectId: id });
      await DELETE.from('resourceagent.Projects').where({ ID: id });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Assignments ───────────────────────────────────────────────────────────
  app.post('/data/Assignments', async (req, res) => {
    try {
      const { employeeId, projectId, startDate, endDate } = req.body;
      const overlapping = await SELECT.from('resourceagent.Assignments')
        .where({ employeeId, startDate: { '<=': endDate }, endDate: { '>=': startDate } });
      if (overlapping.length >= 2)
        return res.status(400).json({ error: 'Employee already has 2 assignments in this period' });
      const id = 'a' + Date.now();
      await INSERT.into('resourceagent.Assignments').entries({ ID: id, employeeId, projectId, startDate, endDate });
      res.json({ ID: id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.patch('/data/Assignments/:id', async (req, res) => {
    try {
      const { employeeId, projectId, startDate, endDate } = req.body;
      const updates = {};
      if (employeeId !== undefined) updates.employeeId = employeeId;
      if (projectId !== undefined)  updates.projectId  = projectId;
      if (startDate !== undefined)  updates.startDate  = startDate;
      if (endDate !== undefined)    updates.endDate    = endDate;
      await UPDATE('resourceagent.Assignments').set(updates).where({ ID: req.params.id });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/data/Assignments/:id', async (req, res) => {
    try {
      await DELETE.from('resourceagent.Assignments').where({ ID: req.params.id });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  console.log('[server.js] routes registered');
});

module.exports = cds.server;
