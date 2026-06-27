# Resource Management Agent

A conversational AI agent for managing project staffing across a team of ~70 employees. Managers interact via natural language chat; the agent autonomously queries data and performs assignments.

The UI features a **Frappe Gantt** timeline with a blue/amber color scheme inspired by clean business design, split into a wide Gantt panel and a compact chat sidebar.

---

## Screenshot

```
┌─────────────────────────────────────┬──────────────┐
│  Team Timeline (72%)                │ Agent Chat   │
│                                     │  (28%)       │
│  Jan  Feb  Mar  Apr  May  Jun  Jul  │              │
│  ████████████████████░░░░  Alice    │ [message]    │
│  ░░░░░░░░░██████████████░  Bob      │ [reply]      │
│  ████████████████░░░░░░░░  Carol    │              │
│                          ▲ Today   │ [input ▶]    │
└─────────────────────────────────────┴──────────────┘
```

---

## Architecture

```
Browser (Single-page HTML)
  ├── Left panel (72%): Gantt timeline — Frappe Gantt, employee × project bars
  └── Right panel (28%): Agent chat — natural language interface
        │
        ▼
CAP Node.js Backend (port 4005)
  ├── GET  /api/*          — OData v4 read-only queries (Employees, Projects, Assignments, Skills)
  ├── POST /data/*         — Custom CRUD routes (bypasses OData UUID validation)
  └── POST /agent/chat     — Agentic loop: forwards messages to Claude API with tool use
        │
        ▼
Claude API  (claude-sonnet-4-6, via local proxy at localhost:6655/anthropic)
  └── 15 tools — see Tool Inventory below
        │
        ▼
SQLite in-memory DB  (seeded from db/data/*.csv on startup)
```

---

## Data Model

```
Employees          Skills
  ID (short)         ID (short)
  name               name
  email
  seniority (T1–T4)
       │                  │
       └── EmployeeSkills ┘
             employeeId
             skillId
             level (1–5)

Projects
  ID (short)
  name
  description
  startDate / endDate
  status (active | booked | open)
       │
       └── ProjectSkills
             projectId / skillId

Assignments
  ID (short)
  employeeId
  projectId
  startDate / endDate
```

**Seniority:** T1 entry → T2 junior → T3 mid → T4 senior/expert  
**Skill level:** 1 (beginner) → 5 (expert)  
**Assignment cap:** max 2 concurrent projects per employee (enforced in both CRUD and agent tools)

---

## Project Structure

```
resource-agent/
├── db/
│   ├── schema.cds                        # Data model
│   └── data/
│       ├── resourceagent-Employees.csv   # 70 employees
│       ├── resourceagent-Skills.csv      # 16 skills
│       ├── resourceagent-EmployeeSkills.csv
│       ├── resourceagent-Projects.csv    # 15 projects
│       ├── resourceagent-ProjectSkills.csv
│       └── resourceagent-Assignments.csv # ~81 assignments
├── srv/
│   ├── resource-service.cds              # OData service at /api
│   ├── resource-service.js               # Assignment cap validation
│   └── agent-service.js                  # Claude client + 15 tool definitions + implementations
├── app/
│   └── resource-ui/webapp/
│       └── index.html                    # Single-page UI (pure HTML/CSS/JS + Frappe Gantt)
├── server.js                             # CDS bootstrap: registers /agent/chat + /data/* routes
├── .env                                  # ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL (not committed)
├── .cdsrc.json                           # live_reload: false
└── package.json
```

---

## Running Locally

```bash
npm install
npm run dev        # cds-serve — starts on http://localhost:4005
```

Open `http://localhost:4005/resource-ui/webapp/index.html`

If port 4005 is in use:
```powershell
Get-Process -Name node | Stop-Process -Force
```

Create a `.env` file in the project root:
```
ANTHROPIC_API_KEY=your_api_key_here
ANTHROPIC_BASE_URL=https://api.anthropic.com  # or your proxy
```

---

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/Employees` | OData — list employees |
| GET | `/api/Projects` | OData — list projects |
| GET | `/api/Assignments` | OData — list assignments |
| GET | `/api/Skills` | OData — list skills |
| GET | `/api/EmployeeSkills` | OData — list employee skills |
| POST | `/agent/chat` | Agent chat (message + conversationHistory) |
| POST | `/data/Employees` | Create employee |
| PATCH | `/data/Employees/:id` | Update employee |
| DELETE | `/data/Employees/:id` | Delete employee + skills + assignments |
| POST | `/data/EmployeeSkills/:employeeId` | Replace all skills for an employee |
| POST | `/data/Projects` | Create project |
| PATCH | `/data/Projects/:id` | Update project |
| DELETE | `/data/Projects/:id` | Delete project + assignments + project skills |
| POST | `/data/Assignments` | Create assignment (enforces 2-project cap) |
| PATCH | `/data/Assignments/:id` | Update assignment dates |
| DELETE | `/data/Assignments/:id` | Delete assignment |

---

## Agent Tool Inventory

| Tool | Description |
|------|-------------|
| `getEmployeeList` | All employees with current assignment count |
| `getEmployeeProfile` | Skills + full assignment history for one employee |
| `getEmployeeTimeline` | Assignment timeline with optional date range filter |
| `getAvailableEmployees` | Employees with < 2 assignments in a given period |
| `matchEmployeesForProject` | Ranked candidates by skill match + availability |
| `getProjectList` | All projects, filterable by status |
| `createAssignment` | Assign employee to project (validates 2-project cap) |
| `updateAssignment` | Change start/end date of an existing assignment |
| `deleteAssignment` | Remove an employee from a project |
| `createSkill` | Add a new skill (deduplicates by name) |
| `assignSkillToEmployee` | Set or update an employee's skill level |
| `createProject` | Create a new project |
| `updateProject` | Update project name / dates / status / description |
| `createEmployee` | Add a new employee |
| `deleteEmployee` | Remove employee and all their assignments |

---

## UI Design

### Color Scheme

| Role | Color | Usage |
|------|-------|-------|
| `#437FC7` | Deep Blue | Header, buttons, Active bars |
| `#F3F33B` | Bright Yellow | Booked bars |
| `#EDF6FF` | Mist Blue | Page background |
| `#FFFFFF` | White | Panel surfaces |

### Gantt Panel (left 72%)

- Powered by **[Frappe Gantt](https://frappe.io/gantt)** v1.2.2 (MIT, CDN)
- All employees as rows; project bars colour-coded by status:
  - **Active** (on project) = Deep Blue `#437FC7`
  - **Booked** (not started) = Bright Yellow `#F3F33B`
  - **Open** projects are hidden from timeline
- Today line highlighted; auto-scrolls to current date on load
- Month selector: This Month / Next Month / Next 3 Months / Next 6 Months

### Chat Panel (right 28%)

- Conversation history persisted in browser session
- Gantt auto-refreshes after any assignment mutation tool is called
- Pill-shaped input bar with rounded Send button

### Manage Modal

- **Employees tab**: list with skills inline; Edit opens form with skill checkboxes + level selectors
- **Projects tab**: click-to-expand assignments per project; inline Add / Edit / Delete for assignments
