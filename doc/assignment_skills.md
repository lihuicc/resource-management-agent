# Assignment Skills — Design Document

## 1. Overview

Currently the data model tracks what skills an employee *has* (`EmployeeSkills`) and what skills a project *requires* (`ProjectSkills`), but there is no record of which skills an employee actually *used* on a specific assignment. If an employee has React (level 5) and Node.js (level 4) but a project only needed React, that distinction is lost.

This feature adds an `AssignmentSkills` table that records the actual skills applied per assignment. It enables accurate historical profiles ("what did Alice work on and with what skills?"), better future matching ("find someone who has done SAP CAP work in production, not just someone who lists it on their profile"), and a foundation for skill-growth tracking over time.

---

## 2. Current State vs Target State

### Current data model

```
Employees ──< EmployeeSkills >── Skills        (employee's global skill catalogue)
    │
    └──< Assignments >── Projects ──< ProjectSkills >── Skills   (project requirements)
```

The overlap of `EmployeeSkills` and `ProjectSkills` can only approximate which skills were used. It is a snapshot, not a record — it breaks if the employee's skills or the project's requirements are edited later.

### Target data model

```
Employees ──< EmployeeSkills >── Skills
    │
    └──< Assignments >── Projects ──< ProjectSkills >── Skills
              │
              └──< AssignmentSkills >── Skills          (← new: actual skills used)
```

`AssignmentSkills` is a child of `Assignments`. Each row says: "on this specific assignment, this specific skill was applied."

---

## 3. Schema Change

### New entity in `db/schema.cds`

```cds
entity AssignmentSkills {
  key assignmentId : UUID;
  key skillId      : UUID;
  assignment       : Association to Assignments on assignment.ID = assignmentId;
  skill            : Association to Skills on skill.ID = skillId;
}
```

Add a back-reference composition on `Assignments`:

```cds
entity Assignments {
  key ID         : UUID;
  employeeId     : UUID;
  projectId      : UUID;
  startDate      : Date;
  endDate        : Date;
  employee       : Association to Employees on employee.ID = employeeId;
  project        : Association to Projects on project.ID = projectId;
  skills         : Composition of many AssignmentSkills on skills.assignmentId = $self.ID;  // ← new
}
```

### Entity summary

| Field | Type | Notes |
|---|---|---|
| `assignmentId` | UUID (key) | FK → Assignments |
| `skillId` | UUID (key) | FK → Skills |

Composite primary key — one row per (assignment, skill) pair. No level field: the proficiency level lives on `EmployeeSkills` and is looked up from there when needed.

---

## 4. Seed Data Strategy

### Auto-population from intersection

For existing assignments, seed `AssignmentSkills` using the intersection of `EmployeeSkills` and `ProjectSkills`:

```
AssignmentSkills = Assignments
  JOIN EmployeeSkills  ON employeeId
  JOIN ProjectSkills   ON projectId
  WHERE EmployeeSkills.skillId = ProjectSkills.skillId
```

This is the best available approximation from historical data. It will not be 100% accurate (an employee may have contributed skills beyond the project's listed requirements), but it is a sound default.

### Example — Assignment a01 (Alice Chen on Alpha Portal)

Alice's skills: React (s1, level 5), TypeScript (s10, level 4), Node.js (s4, level 3)  
Alpha Portal (p01) requires: React (s1), Node.js (s4), TypeScript (s10)  
Intersection → `AssignmentSkills` seed rows:

```csv
assignmentId,skillId
a01,s1
a01,s4
a01,s10
```

### Seed file

A new CSV file `db/data/resourceagent-AssignmentSkills.csv` will be generated for all 81 existing assignments by applying the intersection logic above. Rows where the intersection is empty (employee has no skills matching the project) are simply omitted.

---

## 5. Backend

### 5.1 OData exposure (`srv/resource-service.cds`)

```cds
entity AssignmentSkills as projection on resourceagent.AssignmentSkills;
```

This exposes the table at `GET /api/AssignmentSkills` for read operations, consistent with all other entities.

### 5.2 REST endpoints (`server.js`)

Two new routes, following the same pattern as the existing `/data/EmployeeSkills/:employeeId` full-replace route:

| Method | Path | Purpose |
|---|---|---|
| POST | `/data/AssignmentSkills/:assignmentId` | Full-replace skills for an assignment |
| GET | `/data/AssignmentSkills/:assignmentId` | Read skills for a single assignment |

**Full-replace semantics (POST):**

```
DELETE FROM AssignmentSkills WHERE assignmentId = :id
INSERT INTO AssignmentSkills (assignmentId, skillId) VALUES (...)  × N
```

Request body:
```json
{ "skillIds": ["s1", "s4", "s10"] }
```

Response:
```json
{ "success": true, "count": 3 }
```

This mirrors how `EmployeeSkills` updates work today — no partial patch, always a full replace. It is simpler and avoids partial-update edge cases.

### 5.3 Cascade delete

When an `Assignment` is deleted (via `DELETE /data/Assignments/:id`), its `AssignmentSkills` rows must also be deleted. Add to the existing delete handler in `server.js`:

```js
await DELETE.from('resourceagent.AssignmentSkills').where({ assignmentId: id });
// existing: await DELETE.from('resourceagent.Assignments').where({ ID: id });
```

Similarly, `deleteEmployee` in `agent-service.js` cascades through Assignments — those cascades already delete the Assignments rows, but `AssignmentSkills` must be deleted first:

```js
// For each assignment of the employee:
await DELETE.from('resourceagent.AssignmentSkills').where({ assignmentId: assignmentIds });
await DELETE.from('resourceagent.Assignments').where({ employeeId: emp.ID });
```

---

## 6. Agent Tools

Two new tools are added to `srv/agent-service.js`.

### 6.1 `getAssignmentSkills`

Returns the skills recorded for a specific assignment, identified by employee + project name.

**Input schema:**
```json
{
  "employeeName": "string",
  "projectName":  "string"
}
```

**Returns:**
```json
{
  "employee":   "Alice Chen",
  "project":    "Alpha Portal",
  "startDate":  "2026-01-01",
  "endDate":    "2026-08-31",
  "skills":     [
    { "skillId": "s1",  "name": "React",      "employeeLevel": 5 },
    { "skillId": "s4",  "name": "Node.js",    "employeeLevel": 3 },
    { "skillId": "s10", "name": "TypeScript", "employeeLevel": 4 }
  ]
}
```

`employeeLevel` is joined from `EmployeeSkills` so the agent can report both "what was used" and "how well."

### 6.2 `setAssignmentSkills`

Sets (full-replace) the skills for an assignment. Intended for the manager to record or correct what skills were actually used.

**Input schema:**
```json
{
  "employeeName": "string",
  "projectName":  "string",
  "skillNames":   ["string"]
}
```

**Behaviour:**
1. Resolve employee and project by name (partial match, same as other tools)
2. Look up the assignment row
3. Resolve each skill name to a `skillId` (creates the skill if not found, same as `createSkill`)
4. Full-replace `AssignmentSkills` for that assignment

**Returns:**
```json
{ "success": true, "message": "Set 3 skills for Alice Chen on Alpha Portal: React, Node.js, TypeScript" }
```

### Updated `getEmployeeProfile`

The existing `getEmployeeProfile` tool is extended to include assignment skills in its output:

```json
{
  "name": "Alice Chen",
  "seniority": "T4",
  "skills": [...],
  "assignments": [
    {
      "project":    "Alpha Portal",
      "status":     "active",
      "startDate":  "2026-01-01",
      "endDate":    "2026-08-31",
      "skillsUsed": ["React", "Node.js", "TypeScript"]    // ← new
    }
  ]
}
```

This allows the agent to answer "what has Alice actually worked on and with what skills?" in a single tool call.

---

## 7. Frontend — Manage Modal

### 7.1 Employees tab

The employee edit form currently shows a skill checklist (global skills). After this change, it continues to manage `EmployeeSkills` unchanged.

A new section **Assignment History** appears below the existing assignments list in the read view of an employee. Each assignment row expands to show its recorded skills as chips:

```
┌─ Alice Chen ──────────────────────────────────────────────────────┐
│  ...                                                               │
│  Assignment History                                                │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ Alpha Portal     Jan–Aug 2026  [React] [Node.js] [TypeScript] [✎] │
│  │ Mobile App       Mar–Sep 2026  [React] [TypeScript]           [✎] │
│  └──────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────┘
```

The **[✎] edit** button opens an inline skill selector for that assignment (checkboxes from the full Skills list), saving via `POST /data/AssignmentSkills/:assignmentId`.

### 7.2 Projects tab

The expanded assignment list within each project row gains a skills column:

```
┌─ Alpha Portal (active) ────────────────────────────────────────────┐
│  Assignments:                                                        │
│  Name           Start       End         Skills Used                 │
│  Alice Chen     2026-01-01  2026-08-31  React, Node.js, TypeScript  │
│  Bob Smith      2026-01-01  2026-05-31  React, Node.js              │
└──────────────────────────────────────────────────────────────────── ┘
```

Skills are read from `AssignmentSkills` via `GET /api/AssignmentSkills?$filter=assignmentId eq '...'` (or a bulk fetch of all `AssignmentSkills` alongside the existing bulk fetches at load time).

---

## 8. Data Flow

### Reading assignment skills (frontend)

```
loadAll()
  → GET /api/AssignmentSkills          (bulk fetch, all rows)
  → index in JS: Map<assignmentId → skillId[]>
  → join with Skills list for display names
```

### Setting assignment skills (manager via UI)

```
[✎] clicked on assignment row
  → POST /data/AssignmentSkills/:assignmentId  { skillIds: [...] }
  → backend: DELETE old rows, INSERT new rows
  → UI re-renders skill chips for that row (no full reload needed)
```

### Agent querying

```
"What did Alice work on and what skills did she use?"
  → getEmployeeProfile("Alice Chen")
  → returns assignments[] each with skillsUsed[]
  → agent formats response
```

### Agent setting skills

```
"Record that Alice used React and Node.js on Alpha Portal"
  → setAssignmentSkills("Alice Chen", "Alpha Portal", ["React", "Node.js"])
  → backend resolves IDs, full-replace AssignmentSkills for that assignment
```

---

## 9. Impact on Existing Behaviour

| Existing behaviour | Impact |
|---|---|
| `createAssignment` tool | No change to signature. After creation, `AssignmentSkills` is empty (skills are set separately or auto-populated from intersection on demand). |
| `deleteAssignment` tool | Must cascade-delete `AssignmentSkills` before deleting the `Assignments` row. |
| `deleteEmployee` tool | Must cascade-delete `AssignmentSkills` for all employee assignments before deleting `Assignments` rows. |
| `DELETE /data/Assignments/:id` | Must cascade-delete `AssignmentSkills`. |
| `DELETE /data/Employees/:id` | Must cascade-delete `AssignmentSkills`. |
| `matchEmployeesForProject` | No change — still uses `EmployeeSkills` for matching, not `AssignmentSkills`. Future enhancement: weight candidates who have `AssignmentSkills` experience on similar projects. |
| `getEmployeeProfile` | Extended output only — additive, non-breaking. |

---

## 10. Implementation Checklist

- [ ] Add `AssignmentSkills` entity to `db/schema.cds`; add `skills` composition on `Assignments`
- [ ] Generate `db/data/resourceagent-AssignmentSkills.csv` from intersection logic
- [ ] Expose `AssignmentSkills` in `srv/resource-service.cds`
- [ ] Add `POST /data/AssignmentSkills/:assignmentId` and `GET /data/AssignmentSkills/:assignmentId` to `server.js`
- [ ] Add `AssignmentSkills` cascade-delete to `DELETE /data/Assignments/:id` handler
- [ ] Add `AssignmentSkills` cascade-delete to `DELETE /data/Employees/:id` handler
- [ ] Implement `getAssignmentSkills` tool in `agent-service.js`
- [ ] Implement `setAssignmentSkills` tool in `agent-service.js`
- [ ] Update `getEmployeeProfile` to include `skillsUsed` per assignment
- [ ] Update `deleteEmployee` tool implementation to cascade `AssignmentSkills`
- [ ] Add `AssignmentSkills` bulk fetch to `loadAll()` in `Main.controller.js`
- [ ] Render skill chips in Employees tab assignment history; add `[✎]` inline editor
- [ ] Render skills column in Projects tab assignment list
- [ ] Test: create assignment → skills empty → set skills → verify display
- [ ] Test: delete assignment → verify AssignmentSkills rows removed
- [ ] Test: delete employee → verify cascade through assignments → AssignmentSkills
