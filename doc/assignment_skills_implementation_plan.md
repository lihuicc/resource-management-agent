# Assignment Skills Implementation Plan

## Context

The current system tracks employee skills (`EmployeeSkills`) and project requirements (`ProjectSkills`), but lacks a record of which specific skills were actually used on each assignment. This makes historical analysis, skill growth tracking, and future matching less accurate.

**Problem:** When an employee with React (5), Node.js (4), and TypeScript (3) works on a project requiring React and Node.js, there's no permanent record of which skills were actually applied. If either the employee's skills or project requirements change later, the historical context is lost.

**Solution:** Add `AssignmentSkills` entity to record the actual skills used per assignment, enabling:
- Accurate historical profiles ("what did Alice actually work on?")
- Better matching ("find someone who has used SAP CAP in production")
- Foundation for skill growth tracking over time

---

## Implementation Steps

### Phase 1: Database Schema and Seed Data

**1.1 Update `db/schema.cds`**

Add the new `AssignmentSkills` entity following the existing composite key pattern used by `EmployeeSkills` and `ProjectSkills`:

```cds
entity AssignmentSkills {
  key assignmentId : UUID;
  key skillId      : UUID;
  assignment       : Association to Assignments on assignment.ID = assignmentId;
  skill            : Association to Skills on skill.ID = skillId;
}
```

Add composition to `Assignments` entity (after line 50):

```cds
entity Assignments {
  key ID         : UUID;
  employeeId     : UUID;
  projectId      : UUID;
  startDate      : Date;
  endDate        : Date;
  employee       : Association to Employees on employee.ID = employeeId;
  project        : Association to Projects on project.ID = projectId;
  skills         : Composition of many AssignmentSkills on skills.assignmentId = $self.ID;
}
```

**1.2 Generate seed data**

Create `db/data/resourceagent-AssignmentSkills.csv` by computing the intersection of `EmployeeSkills` and `ProjectSkills` for each existing assignment:

```
AssignmentSkills = Assignments
  JOIN EmployeeSkills ON assignments.employeeId = employeeSkills.employeeId
  JOIN ProjectSkills ON assignments.projectId = projectSkills.projectId
  WHERE employeeSkills.skillId = projectSkills.skillId
```

Expected output format:
```csv
assignmentId,skillId
a01,s1
a01,s4
a01,s10
```

This will generate ~150-200 rows based on skill overlaps in the existing 81 assignments.

---

### Phase 2: Backend API

**2.1 Expose in OData service**

Add to `srv/resource-service.cds` (after line 11):

```cds
entity AssignmentSkills as projection on resourceagent.AssignmentSkills;
```

This exposes the entity at `GET /api/AssignmentSkills` for reading.

**2.2 Add REST endpoints in `server.js`**

Following the existing `/data/EmployeeSkills/:employeeId` pattern (lines 240-252), add two endpoints after the Assignments section (after line 320):

```javascript
// ── Assignment Skills ─────────────────────────────────────────────────
app.post('/data/AssignmentSkills/:assignmentId', async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const { skillIds } = req.body; // ["s1", "s4", "s10"]
    await DELETE.from('resourceagent.AssignmentSkills').where({ assignmentId });
    if (skillIds && skillIds.length) {
      await INSERT.into('resourceagent.AssignmentSkills').entries(
        skillIds.map(skillId => ({ assignmentId, skillId }))
      );
    }
    res.json({ success: true, count: skillIds?.length || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/data/AssignmentSkills/:assignmentId', async (req, res) => {
  try {
    const rows = await SELECT.from('resourceagent.AssignmentSkills')
      .where({ assignmentId: req.params.assignmentId });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
```

**2.3 Add cascade deletes**

Update existing delete handlers to cascade `AssignmentSkills`:

**In `DELETE /data/Assignments/:id` handler (line 315)**, add before the Assignments delete:
```javascript
await DELETE.from('resourceagent.AssignmentSkills').where({ assignmentId: id });
```

**In `DELETE /data/Employees/:id` handler (line 232)**, get assignment IDs first, then delete:
```javascript
const assignments = await SELECT.from('resourceagent.Assignments')
  .columns('ID').where({ employeeId: id });
const assignmentIds = assignments.map(a => a.ID);
if (assignmentIds.length) {
  await DELETE.from('resourceagent.AssignmentSkills').where({ assignmentId: assignmentIds });
}
await DELETE.from('resourceagent.Assignments').where({ employeeId: id });
```

---

### Phase 3: Agent Tools

Add two new tools to `srv/agent-service.js` following the existing tool patterns.

**3.1 Add tool definitions**

Insert into the `TOOLS` array (after `deleteEmployee` tool, around line 204):

```javascript
{
  name: 'getAssignmentSkills',
  description: 'Get the skills recorded for a specific assignment by employee and project name.',
  input_schema: {
    type: 'object',
    properties: {
      employeeName: { type: 'string', description: 'Full or partial name of the employee' },
      projectName:  { type: 'string', description: 'Full or partial name of the project' }
    },
    required: ['employeeName', 'projectName']
  }
},
{
  name: 'setAssignmentSkills',
  description: 'Set (full-replace) the skills for an assignment. Used to record or correct which skills were actually used.',
  input_schema: {
    type: 'object',
    properties: {
      employeeName: { type: 'string', description: 'Full or partial name of the employee' },
      projectName:  { type: 'string', description: 'Full or partial name of the project' },
      skillNames:   { type: 'array', items: { type: 'string' }, description: 'Skill names to assign, e.g. ["React", "Node.js"]' }
    },
    required: ['employeeName', 'projectName', 'skillNames']
  }
}
```

**3.2 Implement tool functions**

Add implementations before the dispatcher (around line 500):

```javascript
async function getAssignmentSkills({ employeeName, projectName }) {
  // Fuzzy match employee and project (reuse existing pattern from lines 222-224)
  const employees = await SELECT.from('resourceagent.Employees')
    .where(`lower(name) like lower('%${employeeName}%')`);
  if (!employees.length) return { error: `No employee found matching "${employeeName}"` };
  
  const projects = await SELECT.from('resourceagent.Projects')
    .where(`lower(name) like lower('%${projectName}%')`);
  if (!projects.length) return { error: `No project found matching "${projectName}"` };
  
  const emp = employees[0];
  const proj = projects[0];
  
  // Find the assignment
  const assignments = await SELECT.from('resourceagent.Assignments')
    .where({ employeeId: emp.ID, projectId: proj.ID });
  if (!assignments.length) return { error: `No assignment found for ${emp.name} on ${proj.name}` };
  
  const assignment = assignments[0];
  
  // Get assignment skills
  const assignmentSkills = await SELECT.from('resourceagent.AssignmentSkills')
    .where({ assignmentId: assignment.ID });
  
  // Get skill details with employee levels
  const skillIds = assignmentSkills.map(as => as.skillId);
  const skills = skillIds.length
    ? await SELECT.from('resourceagent.Skills').where({ ID: skillIds })
    : [];
  const employeeSkills = skillIds.length
    ? await SELECT.from('resourceagent.EmployeeSkills')
        .where({ employeeId: emp.ID, skillId: skillIds })
    : [];
  
  const skillList = assignmentSkills.map(as => {
    const skill = skills.find(s => s.ID === as.skillId);
    const empSkill = employeeSkills.find(es => es.skillId === as.skillId);
    return {
      skillId: as.skillId,
      name: skill?.name || as.skillId,
      employeeLevel: empSkill?.level || null
    };
  });
  
  return {
    employee: emp.name,
    project: proj.name,
    startDate: assignment.startDate,
    endDate: assignment.endDate,
    skills: skillList
  };
}

async function setAssignmentSkills({ employeeName, projectName, skillNames }) {
  // Fuzzy match employee and project
  const employees = await SELECT.from('resourceagent.Employees')
    .where(`lower(name) like lower('%${employeeName}%')`);
  if (!employees.length) return { error: `No employee found matching "${employeeName}"` };
  
  const projects = await SELECT.from('resourceagent.Projects')
    .where(`lower(name) like lower('%${projectName}%')`);
  if (!projects.length) return { error: `No project found matching "${projectName}"` };
  
  const emp = employees[0];
  const proj = projects[0];
  
  // Find assignment
  const assignments = await SELECT.from('resourceagent.Assignments')
    .where({ employeeId: emp.ID, projectId: proj.ID });
  if (!assignments.length) return { error: `No assignment found for ${emp.name} on ${proj.name}` };
  
  const assignment = assignments[0];
  
  // Resolve skill names to IDs (create if needed, like createSkill does)
  const skillIds = [];
  for (const skillName of skillNames) {
    let skill = await SELECT.one.from('resourceagent.Skills')
      .where(`lower(name) = lower('${skillName}')`);
    if (!skill) {
      const skillId = 's' + Date.now() + Math.random().toString(36).slice(2);
      await INSERT.into('resourceagent.Skills').entries({ ID: skillId, name: skillName });
      skill = { ID: skillId };
    }
    skillIds.push(skill.ID);
  }
  
  // Full-replace assignment skills
  await DELETE.from('resourceagent.AssignmentSkills').where({ assignmentId: assignment.ID });
  if (skillIds.length) {
    await INSERT.into('resourceagent.AssignmentSkills').entries(
      skillIds.map(skillId => ({ assignmentId: assignment.ID, skillId }))
    );
  }
  
  return {
    success: true,
    message: `Set ${skillIds.length} skills for ${emp.name} on ${proj.name}: ${skillNames.join(', ')}`
  };
}
```

**3.3 Update dispatcher**

Add to the switch statement (around line 520):

```javascript
case 'getAssignmentSkills':  return getAssignmentSkills(input);
case 'setAssignmentSkills':  return setAssignmentSkills(input);
```

**3.4 Extend `getEmployeeProfile`**

Update the existing `getEmployeeProfile` function (around line 250) to include `skillsUsed` in each assignment:

```javascript
// After fetching assignments and projects (around line 247), add:
const assignmentIds = assignments.map(a => a.ID);
const allAssignmentSkills = assignmentIds.length
  ? await SELECT.from('resourceagent.AssignmentSkills').where({ assignmentId: assignmentIds })
  : [];

const assignmentList = assignments.map(a => {
  const asSkills = allAssignmentSkills.filter(as => as.assignmentId === a.ID);
  const skillNames = asSkills.map(as => 
    skills.find(s => s.ID === as.skillId)?.name || as.skillId
  );
  
  return {
    project: projects.find(p => p.ID === a.projectId)?.name || a.projectId,
    status:  projects.find(p => p.ID === a.projectId)?.status,
    startDate: a.startDate,
    endDate:   a.endDate,
    skillsUsed: skillNames
  };
});
```

---

### Phase 4: Frontend UI

**4.1 Update `loadAll()` function**

Add bulk fetch for AssignmentSkills (around line 420):

```javascript
async function loadAll() {
  [employees, projects, assignments, skills, employeeSkills, projectSkills, assignmentSkills] = 
    await Promise.all([
      fetch('/api/Employees?$orderby=name').then(r => r.json()).then(d => d.value),
      fetch('/api/Projects?$orderby=name').then(r => r.json()).then(d => d.value),
      fetch('/api/Assignments').then(r => r.json()).then(d => d.value),
      fetch('/api/Skills?$orderby=name').then(r => r.json()).then(d => d.value),
      fetch('/api/EmployeeSkills').then(r => r.json()).then(d => d.value),
      fetch('/api/ProjectSkills').then(r => r.json()).then(d => d.value),
      fetch('/api/AssignmentSkills').then(r => r.json()).then(d => d.value),
    ]);
}
```

Declare the variable at the top (around line 400):

```javascript
let assignmentSkills = [];
```

**4.2 Employees tab - Assignment History section**

In the `_employeeRowExpanded()` function (around line 660), add an Assignment History section after the skills display:

```javascript
// After skills section, add:
const empAssignments = assignments.filter(a => a.employeeId === emp.ID);
const assignmentRows = empAssignments.map(a => {
  const proj = projects.find(p => p.ID === a.projectId);
  const asSkills = assignmentSkills.filter(as => as.assignmentId === a.ID);
  const skillNames = asSkills.map(as => {
    const skill = skills.find(s => s.ID === as.skillId);
    return skill ? skill.name : as.skillId;
  });
  
  const skillChips = skillNames.length
    ? skillNames.map(sn => `<span class="skillChip">${escHtml(sn)}</span>`).join(' ')
    : '<span style="color:var(--muted);font-size:12px">(no skills recorded)</span>';
  
  return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
    <div style="flex:1">
      <strong>${escHtml(proj?.name || a.projectId)}</strong>
      <span style="color:var(--muted);font-size:12px;margin-left:8px">${a.startDate} – ${a.endDate}</span>
    </div>
    <div style="flex:2;display:flex;align-items:center;gap:4px;flex-wrap:wrap">${skillChips}</div>
    <button class="btnIconSmall" onclick="editAssignmentSkills('${a.ID}')" title="Edit skills">✎</button>
  </div>`;
}).join('');

html += `
  <div style="margin-top:16px">
    <div style="font-weight:700;font-size:12px;color:var(--muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px">Assignment History</div>
    ${assignmentRows || '<div style="color:var(--muted);font-size:12px;padding:8px 0">No assignments</div>'}
  </div>`;
```

**4.3 Projects tab - Skills column**

In the `_projectRowExpanded()` function (around line 740), add skills to the assignment list:

```javascript
const assignmentRows = projAssignments.map(a => {
  const emp = employees.find(e => e.ID === a.employeeId);
  const asSkills = assignmentSkills.filter(as => as.assignmentId === a.ID);
  const skillNames = asSkills.map(as => {
    const skill = skills.find(s => s.ID === as.skillId);
    return skill?.name || as.skillId;
  });
  
  return `<tr>
    <td>${escHtml(emp?.name || a.employeeId)}</td>
    <td>${a.startDate}</td>
    <td>${a.endDate}</td>
    <td style="font-size:12px;color:var(--muted)">${skillNames.join(', ') || '—'}</td>
    <td style="text-align:right">
      <button class="btnIconSmall" onclick="editForm('assignment',${JSON.stringify(a).replace(/"/g,'&quot;')},null,'${proj.ID}')" title="Edit">✎</button>
      <button class="btnIconSmall" onclick="deleteRecord('Assignments','${a.ID}')" title="Delete">🗑</button>
    </td>
  </tr>`;
}).join('');

// Update table header (around line 735):
const table = `<table class="dataTable" style="width:100%;margin-top:8px">
  <thead><tr>
    <th>Employee</th><th>Start</th><th>End</th><th>Skills Used</th><th style="width:80px"></th>
  </tr></thead>
  <tbody>${assignmentRows}</tbody>
</table>`;
```

**4.4 Edit Assignment Skills modal**

Add a new function for editing assignment skills (around line 880):

```javascript
let editingAssignmentId = null;

function editAssignmentSkills(assignmentId) {
  editingAssignmentId = assignmentId;
  const assignment = assignments.find(a => a.ID === assignmentId);
  if (!assignment) return;
  
  const emp = employees.find(e => e.ID === assignment.employeeId);
  const proj = projects.find(p => p.ID === assignment.projectId);
  const asSkills = assignmentSkills.filter(as => as.assignmentId === assignmentId);
  const selectedSkillIds = asSkills.map(as => as.skillId);
  
  const skillCheckboxes = skills.map(s => {
    const checked = selectedSkillIds.includes(s.ID);
    return `<div style="padding:4px 0">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" data-asskill-id="${s.ID}" ${checked ? 'checked' : ''}>
        <span>${escHtml(s.name)}</span>
      </label>
    </div>`;
  }).join('');
  
  document.getElementById('modalTitle').textContent = 'Edit Assignment Skills';
  document.getElementById('modalBody').innerHTML = `
    <div style="margin-bottom:12px">
      <div style="font-weight:600;margin-bottom:4px">${escHtml(emp?.name || '')}</div>
      <div style="color:var(--muted);font-size:12px">${escHtml(proj?.name || '')}</div>
      <div style="color:var(--muted);font-size:11px">${assignment.startDate} – ${assignment.endDate}</div>
    </div>
    <div style="font-weight:600;font-size:12px;margin-bottom:8px">Skills Used</div>
    <div style="max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:8px">
      ${skillCheckboxes}
    </div>
    <div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
      <button class="btnSecondary" onclick="closeModal()">Cancel</button>
      <button class="btnPrimary" onclick="saveAssignmentSkills()">Save</button>
    </div>
  `;
  document.getElementById('manageModal').style.display = 'flex';
}

async function saveAssignmentSkills() {
  const selectedSkillIds = [];
  document.querySelectorAll('[data-asskill-id]').forEach(cb => {
    if (cb.checked) selectedSkillIds.push(cb.dataset.asskillId);
  });
  
  try {
    const res = await fetch(`/data/AssignmentSkills/${editingAssignmentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillIds: selectedSkillIds })
    });
    
    if (!res.ok) {
      const err = await res.json();
      alert('Error: ' + (err.error || 'Unknown error'));
      return;
    }
    
    closeModal();
    await loadAll();
    renderTab(currentTab);
  } catch (err) {
    alert('Save failed: ' + err.message);
  }
}
```

**4.5 Add CSS for skill chips**

Add to the `<style>` section (around line 180):

```css
.skillChip {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 12px;
  background: var(--mac-lilac);
  color: var(--text);
  font-size: 11px;
  font-weight: 500;
}
```

---

## Critical Files to Modify

1. **db/schema.cds** - Add `AssignmentSkills` entity and composition
2. **db/data/resourceagent-AssignmentSkills.csv** - New seed data file
3. **srv/resource-service.cds** - Expose AssignmentSkills in OData
4. **server.js** - Add REST endpoints and cascade deletes
5. **srv/agent-service.js** - Add two new tools + extend getEmployeeProfile
6. **app/resource-ui/webapp/index.html** - UI updates for displaying and editing assignment skills

---

## Testing & Verification

### 1. Database verification
```bash
npm run dev
# Open http://localhost:4005/api/AssignmentSkills
# Should return ~150-200 rows from seed data
```

### 2. Agent tools testing
Via chat interface:
- "What skills did Alice Chen use on Alpha Portal?"
- "Record that Bob Smith used React and TypeScript on Beta Dashboard"
- "Show me Alice's full profile including assignment skills"

### 3. UI testing
- **Employees tab:**
  - Expand an employee row → verify Assignment History shows with skill chips
  - Click ✎ on an assignment → edit skills → save → verify chips update
- **Projects tab:**
  - Expand a project → verify Skills Used column appears
  - Create new assignment → verify skills empty → edit via employee tab → verify appears in project tab

### 4. Cascade delete testing
- Delete an assignment → verify AssignmentSkills rows removed
- Delete an employee → verify all their AssignmentSkills removed via cascade

### 5. REST API testing
```bash
# Get skills for assignment a01
curl http://localhost:4005/data/AssignmentSkills/a01

# Set skills for assignment a01
curl -X POST http://localhost:4005/data/AssignmentSkills/a01 \
  -H "Content-Type: application/json" \
  -d '{"skillIds": ["s1", "s4"]}'
```

---

## Edge Cases & Notes

1. **Empty assignments:** New assignments will have no AssignmentSkills initially. The UI shows "(no skills recorded)" placeholder.

2. **Skill name resolution:** `setAssignmentSkills` creates new skills if they don't exist (following `createSkill` pattern).

3. **Backward compatibility:** Existing API endpoints unchanged. This is purely additive.

4. **Performance:** All new queries use indexed foreign keys. The bulk fetch in `loadAll()` adds one more parallel request (~150 rows), negligible overhead.

5. **Data consistency:** Seed data represents best-effort historical reconstruction. Going forward, skills should be explicitly set via UI or agent.
