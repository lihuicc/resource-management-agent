const cds = require('@sap/cds');
const express = require('express');

cds.on('bootstrap', (app) => {
  app.use(express.json());

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
