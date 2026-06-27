# Resource Management Agent — Design Document

## 1. Overview

Resource Management Agent is a single-page web application that helps a project team manager (~70 employees) allocate people to projects. It combines a Gantt-chart timeline with an AI chat assistant powered by Claude. The manager can view team assignments visually, manage employees and projects through a modal UI, and issue natural-language instructions to the AI agent, which can query data and create/update/delete assignments autonomously.

---

## 2. Architecture

```
Browser (index.html)
  │
  ├─ GET/POST  /api/*          ← OData (SAP CAP ResourceService)
  ├─ POST/PATCH/DELETE /data/* ← Custom REST (server.js)
  └─ POST /agent/chat          ← Agent endpoint (server.js → agent-service.js)
                                        │
                                        └─ Anthropic Claude API
                                           (claude-sonnet-4-6, tool use)
```

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 20 |
| Framework | SAP CAP (`@sap/cds` v9) |
| Database | SQLite in-memory (dev), swappable via `cds.requires.db` |
| AI SDK | `@anthropic-ai/sdk` v0.39 |
| Frontend | Vanilla JS + HTML/CSS (no framework) |
| Gantt chart | frappe-gantt v1.2.2 (CDN) |

---

## 3. Data Model

Defined in `db/schema.cds`, namespace `resourceagent`.

```
Employees ──< EmployeeSkills >── Skills
    │
    └──< Assignments >── Projects ──< ProjectSkills >── Skills
```

### Entities

**Employees**
| Field | Type | Notes |
|---|---|---|
| ID | UUID (key) | |
| name | String(100) | |
| email | String(100) | |
| seniority | String(20) | T1 / T2 / T3 / T4 |

**Skills**
| Field | Type |
|---|---|
| ID | UUID (key) |
| name | String(50) |

**EmployeeSkills** (composite key)
| Field | Type | Notes |
|---|---|---|
| employeeId | UUID (key) | FK → Employees |
| skillId | UUID (key) | FK → Skills |
| level | Integer | 1–5 proficiency |

**Projects**
| Field | Type | Notes |
|---|---|---|
| ID | UUID (key) | |
| name | String(100) | |
| description | String(500) | |
| startDate | Date | |
| endDate | Date | |
| status | String(20) | `active` / `booked` / `open` |

**ProjectSkills** (composite key)
| Field | Type | Notes |
|---|---|---|
| projectId | UUID (key) | FK → Projects |
| skillId | UUID (key) | FK → Skills |

**Assignments**
| Field | Type | Notes |
|---|---|---|
| ID | UUID (key) | |
| employeeId | UUID | FK → Employees |
| projectId | UUID | FK → Projects |
| startDate | Date | |
| endDate | Date | |

### Business Rule

An employee may not have more than **2 overlapping assignments** at any point in time. This is enforced in two places:

- `srv/resource-service.js`: CAP `before CREATE` hook on `Assignments`
- `server.js`: REST `POST /data/Assignments` handler
- `srv/agent-service.js`: `createAssignment` tool implementation

---

## 4. Backend

### 4.1 OData Service (`srv/resource-service.cds`)

Exposes all six entities as standard OData projections at `/api`. Used by the frontend for read operations (`GET /api/Employees`, `GET /api/Assignments`, etc.) and for the CAP-generated Fiori preview.

### 4.2 Custom REST Endpoints (`server.js`)

Registered on the Express app via `cds.on('bootstrap')`. Handles write operations that need custom logic beyond what OData provides.

| Method | Path | Purpose |
|---|---|---|
| POST | `/data/Employees` | Create employee |
| PATCH | `/data/Employees/:id` | Update employee |
| DELETE | `/data/Employees/:id` | Delete employee + cascade (skills, assignments) |
| POST | `/data/EmployeeSkills/:employeeId` | Replace all skills for an employee (full replace semantics) |
| POST | `/data/Projects` | Create project |
| PATCH | `/data/Projects/:id` | Update project |
| DELETE | `/data/Projects/:id` | Delete project + cascade (assignments, project skills) |
| POST | `/data/Assignments` | Create assignment (enforces 2-project cap) |
| PATCH | `/data/Assignments/:id` | Update assignment dates |
| DELETE | `/data/Assignments/:id` | Delete assignment |
| POST | `/agent/chat` | Forward message to AI agent, return reply |

### 4.3 Agent Service (`srv/agent-service.js`)

Implements a stateless conversation loop using the Anthropic Claude API with **tool use**.

**Model:** `claude-sonnet-4-6`  
**Max tokens per turn:** 4096  
**Context:** Multi-turn conversation history is passed in by the caller and returned updated.

#### Conversation Loop

```
user message
  → append to messages[]
  → POST to Claude (system prompt + tools + messages)
  ← stop_reason = "end_turn"  → return reply text
  ← stop_reason = "tool_use"  → dispatch each tool_use block
                               → append tool_results to messages[]
                               → repeat
```

#### Available Tools

| Tool | Description |
|---|---|
| `getEmployeeList` | All employees with current assignment count |
| `getEmployeeProfile` | Detailed profile: skills + full assignment history |
| `getEmployeeTimeline` | Assignments for one employee, optional date filter |
| `getAvailableEmployees` | Employees with < 2 assignments in a given period |
| `matchEmployeesForProject` | Available employees ranked by skill match score |
| `getProjectList` | All projects with status and required skills; filterable by status |
| `createAssignment` | Assign employee to project (validates 2-project cap) |
| `updateAssignment` | Change dates on an existing assignment |
| `deleteAssignment` | Remove employee from project |
| `createSkill` | Add a new skill to the catalogue |
| `assignSkillToEmployee` | Set skill + proficiency level on an employee |
| `createProject` | Create a new project |
| `updateProject` | Update project fields |
| `createEmployee` | Add new employee |
| `deleteEmployee` | Remove employee and all associated data |

#### Skill Match Scoring (`matchEmployeesForProject`)

For each available employee, match score is computed as:

```
score = Σ(level / 5)  for each matched required skill
        ─────────────────────────────────────────────
              total required skills
```

Result is a value in [0, 1], rounded to 2 decimal places. Employees with score 0 are excluded.

---

## 5. Frontend

Single file: `app/resource-ui/webapp/index.html`. No build step, no framework.

### 5.1 Layout

```
┌─────────────────────────────────────────────────────────────┐
│  App Header: title │ [1M][2M][3M][6M]  [⚙ Manage] [↺ Refresh] │
├──────────────────────────────────┬──────────────────────────┤
│  TEAM TIMELINE                   │  AGENT CHAT              │
│  legend bar                      │                          │
│  ┌────────────────────────────┐  │  chat messages           │
│  │ [name col] │ gantt bars    │  │                          │
│  └────────────────────────────┘  │  [input] [Send ▶]        │
└──────────────────────────────────┴──────────────────────────┘
```

- Gantt panel: 72% width
- Chat panel: 28% width

### 5.2 Gantt Chart

**Library:** frappe-gantt v1.2.2 loaded from CDN.

**Data source:** `employees` × `assignments` × `projects` — one task row per assignment. Only assignments with project status `active` or `booked` are included (`open` projects are excluded).

**Task format:**
```js
{
  id:           assignment.ID,
  name:         "Employee Name — Project Name",
  start:        assignment.startDate,   // clipped to Jan 1 of current year
  end:          assignment.endDate,
  progress:     0,
  custom_class: "status-active" | "status-booked"
}
```

**View modes (button group):**

| Button | `view_mode` | Granularity |
|---|---|---|
| 1M | `Day` | Per day |
| 2M | `Week` | Per week |
| 3M *(default)* | `Month` | Per month |
| 6M | `Month` | Per month |

**Gantt options:**
- `infinite_padding: false` — no extra whitespace before first task
- `scroll_to: 'today'` — initial scroll position is today's date
- Task start dates are clipped to `<currentYear>-01-01` so the timeline never extends into past years

**Fixed employee name column:**

frappe-gantt does not support a frozen left column natively. The implementation overlays an HTML5 `<canvas>` element (`#ganttNameCanvas`) absolutely positioned over the Gantt panel:

- Canvas width: 150px; height: `ganttContent.clientHeight - headerHeight`
- Top offset is computed at render time: `ganttContent.getBoundingClientRect().top - panel.top + firstBarY`
- `firstBarY` (≈ 94px) is the SVG header height read from the first `rect.bar` element's `y` attribute
- On each `container.onscroll` event, the canvas is redrawn with `scrollTop` applied to the y-coordinates, keeping names aligned with their rows
- Only rows within the visible viewport are drawn (early-exit when `drawY + h < 0 || drawY > visH`)
- Long names are truncated with ellipsis to fit within 150px

### 5.3 Manage Modal

Two tabs accessible via the **⚙ Manage** button:

**Employees tab**
- Table: name, email, level badge, comma-separated skills, edit/delete actions
- Add/edit form: name, email, seniority select (T1–T4), skill checklist with per-skill proficiency level (1–5)
- Skill save uses full-replace semantics via `POST /data/EmployeeSkills/:id`

**Projects tab**
- Collapsible rows: click a project row to expand its assignments inline
- Project fields: name, status badge, start/end dates, description (truncated)
- Per-project inline assignment list with add/edit/delete
- Add assignment form: employee select, project select, start/end date pickers

### 5.4 Agent Chat

- Multi-turn conversation — `conversationHistory` array is maintained in JS and sent on every request
- Conversation cleared with the **Clear** button
- After a reply, if `toolsUsed` contains `createAssignment`, `updateAssignment`, or `deleteAssignment`, `loadAll()` is called to refresh the Gantt automatically
- Messages are HTML-escaped before display; newlines converted to `<br>`

### 5.5 Color Scheme

Two CSS layers are stacked in `<style>` blocks:

1. **Macaron theme** (pink/purple, base definitions)
2. **Blue-Yellow override** (navy `#437FC7` / amber `#B9732F`) — applied last, uses `!important`

Gantt bar colors:
- `status-active`: `#437FC7` (deep blue)
- `status-booked`: `#F3F33B` (yellow, dark label text)

---

## 6. API Reference

### Read endpoints (OData)

```
GET /api/Employees?$orderby=name
GET /api/Assignments
GET /api/Projects?$orderby=name
GET /api/Skills?$orderby=name
GET /api/EmployeeSkills
```

### Write endpoints (custom REST)

See §4.2 table above.

### Agent endpoint

```
POST /agent/chat
Content-Type: application/json

{
  "message": "Who is free next month for a React project?",
  "conversationHistory": []   // array of prior {role, content} turns
}

→ 200 OK
{
  "reply": "...",
  "toolsUsed": ["getAvailableEmployees", "matchEmployeesForProject"],
  "messages": [...]   // updated history to pass back next turn
}
```

---

## 7. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | `dummy-key` | Anthropic API authentication |
| `ANTHROPIC_BASE_URL` | `http://localhost:6655/anthropic` | API base URL (proxy override) |

Set in `.env` or environment. The `baseURL` default points to a local proxy, useful for corporate network routing.

---

## 8. Running Locally

```bash
npm install
npm run dev       # or: npx cds-serve
# → http://localhost:4004/resource-ui/webapp/index.html
```

The database is SQLite in-memory; seed data is loaded from `db/data/*.csv` on startup.
