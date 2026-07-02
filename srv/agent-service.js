const cds = require('@sap/cds');
const Anthropic = require('@anthropic-ai/sdk');

// ── AI Core / Anthropic client（懒加载，支持 BTP OAuth token）────────────────

let _client = null;
let _tokenExpiresAt = 0;
let _accessToken = null;

async function getClient() {
  const now = Date.now();
  if (!process.env.VCAP_SERVICES) {
    if (!_client) {
      _client = new Anthropic({
        apiKey:  process.env.ANTHROPIC_API_KEY || 'dummy-key',
        baseURL: process.env.ANTHROPIC_BASE_URL || 'http://localhost:6655/anthropic'
      });
    }
    return _client;
  }

  // BTP: refresh token if expired
  if (!_accessToken || now >= _tokenExpiresAt) {
    const vcap  = JSON.parse(process.env.VCAP_SERVICES);
    const creds = vcap.aicore[0].credentials;
    const params = new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     creds.clientid,
      client_secret: creds.clientsecret
    });
    const tokenRes = await fetch(`${creds.url}/oauth/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString()
    });
    const { access_token } = await tokenRes.json();
    _accessToken    = access_token;
    _tokenExpiresAt = now + 11 * 60 * 60 * 1000;
  }
  return null;
}

// AI Core requires POST to /invoke, not /v1/messages
async function callAICore(body) {
  const baseURL = process.env.ANTHROPIC_BASE_URL.replace(/\/$/, '');
  const url = `${baseURL}/invoke`;
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'Authorization':     `Bearer ${_accessToken}`,
      'AI-Resource-Group': process.env.AICORE_RESOURCE_GROUP || 'default'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
  return res.json();
}

const SYSTEM_PROMPT = `You are a Resource Management Assistant for a project team of ~70 employees.
You help the manager allocate employees to projects efficiently.

Guidelines:
- Always check availability before recommending someone (max 2 concurrent projects per employee)
- When recommending candidates, explain WHY each person fits (skill match, availability window)
- Before creating an assignment, confirm the action with the manager first
- Be concise. Use lists for multiple candidates.
- When you call tools, use dates in YYYY-MM-DD format; display dates as "June 15, 2025" in conversation.
- When updating or creating assignments, verify dates are logically consistent: endDate must be after startDate, and dates should be in a reasonable range (warn if year seems wrong, e.g. endDate before current year).`;

const TOOLS = [
  {
    name: 'getEmployeeList',
    description: 'Get all employees with their current assignment count and basic info.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'getEmployeeProfile',
    description: 'Get detailed profile of an employee including skills and all assignments.',
    input_schema: {
      type: 'object',
      properties: {
        employeeName: { type: 'string', description: 'Full or partial name of the employee' }
      },
      required: ['employeeName']
    }
  },
  {
    name: 'getEmployeeTimeline',
    description: 'Get all assignments for an employee, optionally filtered by date range.',
    input_schema: {
      type: 'object',
      properties: {
        employeeName: { type: 'string', description: 'Full or partial name of the employee' },
        fromDate: { type: 'string', description: 'Start of range (YYYY-MM-DD), optional' },
        toDate:   { type: 'string', description: 'End of range (YYYY-MM-DD), optional' }
      },
      required: ['employeeName']
    }
  },
  {
    name: 'getAvailableEmployees',
    description: 'Find employees who have fewer than 2 assignments during the given period.',
    input_schema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'Period start (YYYY-MM-DD)' },
        endDate:   { type: 'string', description: 'Period end (YYYY-MM-DD)' }
      },
      required: ['startDate', 'endDate']
    }
  },
  {
    name: 'matchEmployeesForProject',
    description: 'Find available employees ranked by how well their skills match the project requirements.',
    input_schema: {
      type: 'object',
      properties: {
        skills:    { type: 'array', items: { type: 'string' }, description: 'Required skill names e.g. ["React","Node.js"]' },
        startDate: { type: 'string', description: 'Project start (YYYY-MM-DD)' },
        endDate:   { type: 'string', description: 'Project end (YYYY-MM-DD)' }
      },
      required: ['skills', 'startDate', 'endDate']
    }
  },
  {
    name: 'getProjectList',
    description: 'Get all projects with their status, dates, and skill requirements.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'booked', 'open'], description: 'Filter by status, optional' }
      },
      required: []
    }
  },
  {
    name: 'createAssignment',
    description: 'Assign an employee to a project. Validates the 2-project cap before writing.',
    input_schema: {
      type: 'object',
      properties: {
        employeeName: { type: 'string', description: 'Full name of the employee' },
        projectName:  { type: 'string', description: 'Full name of the project' },
        startDate:    { type: 'string', description: 'Assignment start (YYYY-MM-DD)' },
        endDate:      { type: 'string', description: 'Assignment end (YYYY-MM-DD)' }
      },
      required: ['employeeName', 'projectName', 'startDate', 'endDate']
    }
  },
  {
    name: 'updateAssignment',
    description: 'Update the start or end date of an existing assignment for an employee on a project.',
    input_schema: {
      type: 'object',
      properties: {
        employeeName: { type: 'string', description: 'Full or partial name of the employee' },
        projectName:  { type: 'string', description: 'Full or partial name of the project' },
        startDate:    { type: 'string', description: 'New start date (YYYY-MM-DD), optional' },
        endDate:      { type: 'string', description: 'New end date (YYYY-MM-DD), optional' }
      },
      required: ['employeeName', 'projectName']
    }
  },
  {
    name: 'deleteAssignment',
    description: 'Remove an assignment — use when an employee is being released from a project entirely.',
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
    name: 'createSkill',
    description: 'Create a new skill that can be assigned to employees.',
    input_schema: {
      type: 'object',
      properties: {
        skillName: { type: 'string', description: 'Name of the new skill, e.g. "SAP Fiori"' }
      },
      required: ['skillName']
    }
  },
  {
    name: 'assignSkillToEmployee',
    description: 'Assign a skill (with proficiency level 1-5) to an employee. Overwrites existing level if already assigned.',
    input_schema: {
      type: 'object',
      properties: {
        employeeName: { type: 'string', description: 'Full or partial name of the employee' },
        skillName:    { type: 'string', description: 'Name of the skill' },
        level:        { type: 'integer', description: 'Proficiency level 1-5', minimum: 1, maximum: 5 }
      },
      required: ['employeeName', 'skillName', 'level']
    }
  },
  {
    name: 'createProject',
    description: 'Create a new project.',
    input_schema: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'Project name' },
        description: { type: 'string', description: 'Short description, optional' },
        startDate:   { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        endDate:     { type: 'string', description: 'End date (YYYY-MM-DD)' },
        status:      { type: 'string', enum: ['active', 'booked', 'open'], description: 'Project status' }
      },
      required: ['name', 'startDate', 'endDate', 'status']
    }
  },
  {
    name: 'updateProject',
    description: 'Update an existing project\'s name, description, dates, or status.',
    input_schema: {
      type: 'object',
      properties: {
        projectName:  { type: 'string', description: 'Full or partial name of the project to update' },
        name:         { type: 'string', description: 'New project name, optional' },
        description:  { type: 'string', description: 'New description, optional' },
        startDate:    { type: 'string', description: 'New start date (YYYY-MM-DD), optional' },
        endDate:      { type: 'string', description: 'New end date (YYYY-MM-DD), optional' },
        status:       { type: 'string', enum: ['active', 'booked', 'open'], description: 'New status, optional' }
      },
      required: ['projectName']
    }
  },
  {
    name: 'createEmployee',
    description: 'Add a new employee to the team.',
    input_schema: {
      type: 'object',
      properties: {
        name:      { type: 'string', description: 'Full name' },
        email:     { type: 'string', description: 'Email address' },
        seniority: { type: 'string', enum: ['T1', 'T2', 'T3', 'T4'], description: 'Seniority level' }
      },
      required: ['name', 'email', 'seniority']
    }
  },
  {
    name: 'deleteEmployee',
    description: 'Remove an employee and all their assignments from the system.',
    input_schema: {
      type: 'object',
      properties: {
        employeeName: { type: 'string', description: 'Full or partial name of the employee' }
      },
      required: ['employeeName']
    }
  },
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
];

// ── Tool implementations ──────────────────────────────────────────────────────

async function getEmployeeList() {
  const employees = await SELECT.from('resourceagent.Employees').columns('ID', 'name', 'email', 'seniority');
  const today = new Date().toISOString().split('T')[0];
  const assignments = await SELECT.from('resourceagent.Assignments')
    .where(`startDate <= '${today}' and endDate >= '${today}'`);

  const countMap = {};
  assignments.forEach(a => { countMap[a.employeeId] = (countMap[a.employeeId] || 0) + 1; });

  return employees.map(emp => ({ ...emp, currentAssignments: countMap[emp.ID] || 0 }));
}

async function getEmployeeProfile({ employeeName }) {
  const employees = await SELECT.from('resourceagent.Employees')
    .where(`lower(name) like lower('%${employeeName}%')`);
  if (!employees.length) return { error: `No employee found matching "${employeeName}"` };

  const emp = employees[0];

  const empSkills = await SELECT.from('resourceagent.EmployeeSkills')
    .where({ employeeId: emp.ID });
  const skillIds = empSkills.map(es => es.skillId);
  const skills = skillIds.length
    ? await SELECT.from('resourceagent.Skills').where({ ID: skillIds })
    : [];

  const skillList = empSkills.map(es => ({
    skill: skills.find(s => s.ID === es.skillId)?.name || es.skillId,
    level: es.level
  }));

  const assignments = await SELECT.from('resourceagent.Assignments')
    .where({ employeeId: emp.ID })
    .orderBy('startDate');
  const projectIds = assignments.map(a => a.projectId);
  const projects = projectIds.length
    ? await SELECT.from('resourceagent.Projects').where({ ID: projectIds })
    : [];

  // Get assignment skills
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

  return { ...emp, skills: skillList, assignments: assignmentList };
}

async function getEmployeeTimeline({ employeeName, fromDate, toDate }) {
  const employees = await SELECT.from('resourceagent.Employees')
    .where(`lower(name) like lower('%${employeeName}%')`);
  if (!employees.length) return { error: `No employee found matching "${employeeName}"` };

  const emp = employees[0];
  const assignments = await SELECT.from('resourceagent.Assignments')
    .where({ employeeId: emp.ID })
    .orderBy('startDate');

  const filtered = assignments.filter(a => {
    if (fromDate && a.endDate < fromDate) return false;
    if (toDate && a.startDate > toDate)   return false;
    return true;
  });

  const projectIds = filtered.map(a => a.projectId);
  const projects = projectIds.length
    ? await SELECT.from('resourceagent.Projects').where({ ID: projectIds })
    : [];

  return {
    employee: emp.name,
    assignments: filtered.map(a => ({
      project:   projects.find(p => p.ID === a.projectId)?.name || a.projectId,
      status:    projects.find(p => p.ID === a.projectId)?.status,
      startDate: a.startDate,
      endDate:   a.endDate
    }))
  };
}

async function getAvailableEmployees({ startDate, endDate }) {
  const employees = await SELECT.from('resourceagent.Employees').columns('ID', 'name', 'email', 'seniority');
  const overlapping = await SELECT.from('resourceagent.Assignments')
    .where(`startDate <= '${endDate}' and endDate >= '${startDate}'`);

  const countMap = {};
  overlapping.forEach(a => { countMap[a.employeeId] = (countMap[a.employeeId] || 0) + 1; });

  return employees
    .filter(emp => (countMap[emp.ID] || 0) < 2)
    .map(emp => ({ ...emp, assignmentsInPeriod: countMap[emp.ID] || 0 }));
}

async function matchEmployeesForProject({ skills, startDate, endDate }) {
  const available = await getAvailableEmployees({ startDate, endDate });
  if (!available.length) return [];

  const availableIds = available.map(e => e.ID);

  const allSkills = await SELECT.from('resourceagent.Skills');
  const reqSkillIds = allSkills
    .filter(s => skills.some(name => name.toLowerCase() === s.name.toLowerCase()))
    .map(s => s.ID);

  if (!reqSkillIds.length) return [];

  const empSkills = await SELECT.from('resourceagent.EmployeeSkills')
    .where({ employeeId: availableIds, skillId: reqSkillIds });

  const skillNameMap = Object.fromEntries(allSkills.map(s => [s.ID, s.name]));

  const skillMap = {};
  empSkills.forEach(es => {
    if (!skillMap[es.employeeId]) skillMap[es.employeeId] = [];
    skillMap[es.employeeId].push({ skill: skillNameMap[es.skillId], level: es.level });
  });

  return available
    .map(emp => {
      const matched = skillMap[emp.ID] || [];
      const score = matched.length > 0
        ? matched.reduce((sum, es) => sum + es.level / 5, 0) / skills.length
        : 0;
      return { ...emp, matchedSkills: matched, matchScore: Math.round(score * 100) / 100 };
    })
    .filter(e => e.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore);
}

async function getProjectList({ status } = {}) {
  let query = SELECT.from('resourceagent.Projects');
  if (status) query = query.where({ status });
  const projects = await query;

  const allPS = await SELECT.from('resourceagent.ProjectSkills');
  const allSkills = await SELECT.from('resourceagent.Skills');
  const skillNameMap = Object.fromEntries(allSkills.map(s => [s.ID, s.name]));

  return projects.map(p => ({
    ...p,
    requiredSkills: allPS
      .filter(ps => ps.projectId === p.ID)
      .map(ps => skillNameMap[ps.skillId] || ps.skillId)
  }));
}

async function createAssignment({ employeeName, projectName, startDate, endDate }) {
  const employees = await SELECT.from('resourceagent.Employees')
    .where(`lower(name) like lower('%${employeeName}%')`);
  if (!employees.length) return { error: `No employee found matching "${employeeName}"` };

  const projects = await SELECT.from('resourceagent.Projects')
    .where(`lower(name) like lower('%${projectName}%')`);
  if (!projects.length) return { error: `No project found matching "${projectName}"` };

  const emp  = employees[0];
  const proj = projects[0];

  const overlapping = await SELECT.from('resourceagent.Assignments').where({
    employeeId: emp.ID,
    startDate:  { '<=': endDate },
    endDate:    { '>=': startDate }
  });

  if (overlapping.length >= 2) {
    return { error: `${emp.name} already has 2 assignments overlapping this period` };
  }

  await INSERT.into('resourceagent.Assignments').entries({
    ID:         `a${Date.now()}`,
    employeeId: emp.ID,
    projectId:  proj.ID,
    startDate,
    endDate
  });

  return { success: true, message: `${emp.name} has been assigned to ${proj.name} from ${startDate} to ${endDate}` };
}

async function updateAssignment({ employeeName, projectName, startDate, endDate }) {
  const employees = await SELECT.from('resourceagent.Employees')
    .where(`lower(name) like lower('%${employeeName}%')`);
  if (!employees.length) return { error: `No employee found matching "${employeeName}"` };

  const projects = await SELECT.from('resourceagent.Projects')
    .where(`lower(name) like lower('%${projectName}%')`);
  if (!projects.length) return { error: `No project found matching "${projectName}"` };

  const emp  = employees[0];
  const proj = projects[0];

  const existing = await SELECT.from('resourceagent.Assignments')
    .where({ employeeId: emp.ID, projectId: proj.ID });
  if (!existing.length) return { error: `No assignment found for ${emp.name} on ${proj.name}` };

  const assignment = existing[0];
  const updates = {};
  if (startDate) updates.startDate = startDate;
  if (endDate)   updates.endDate   = endDate;

  await UPDATE('resourceagent.Assignments').set(updates).where({ ID: assignment.ID });

  return { success: true, message: `Updated assignment for ${emp.name} on ${proj.name}: ${JSON.stringify(updates)}` };
}

async function deleteAssignment({ employeeName, projectName }) {
  const employees = await SELECT.from('resourceagent.Employees')
    .where(`lower(name) like lower('%${employeeName}%')`);
  if (!employees.length) return { error: `No employee found matching "${employeeName}"` };

  const projects = await SELECT.from('resourceagent.Projects')
    .where(`lower(name) like lower('%${projectName}%')`);
  if (!projects.length) return { error: `No project found matching "${projectName}"` };

  const emp  = employees[0];
  const proj = projects[0];

  const existing = await SELECT.from('resourceagent.Assignments')
    .where({ employeeId: emp.ID, projectId: proj.ID });
  if (!existing.length) return { error: `No assignment found for ${emp.name} on ${proj.name}` };

  await DELETE.from('resourceagent.Assignments').where({ ID: existing[0].ID });

  return { success: true, message: `${emp.name} has been removed from ${proj.name}` };
}

async function createSkill({ skillName }) {
  const existing = await SELECT.from('resourceagent.Skills').where(`lower(name) = lower('${skillName}')`);
  if (existing.length) return { error: `Skill "${skillName}" already exists` };
  const id = 's' + Date.now();
  await INSERT.into('resourceagent.Skills').entries({ ID: id, name: skillName });
  return { success: true, message: `Skill "${skillName}" created with ID ${id}` };
}

async function assignSkillToEmployee({ employeeName, skillName, level }) {
  const employees = await SELECT.from('resourceagent.Employees').where(`lower(name) like lower('%${employeeName}%')`);
  if (!employees.length) return { error: `No employee found matching "${employeeName}"` };

  const skills = await SELECT.from('resourceagent.Skills').where(`lower(name) like lower('%${skillName}%')`);
  if (!skills.length) return { error: `No skill found matching "${skillName}"` };

  const emp   = employees[0];
  const skill = skills[0];

  const existing = await SELECT.from('resourceagent.EmployeeSkills').where({ employeeId: emp.ID, skillId: skill.ID });
  if (existing.length) {
    await UPDATE('resourceagent.EmployeeSkills').set({ level }).where({ employeeId: emp.ID, skillId: skill.ID });
    return { success: true, message: `Updated ${emp.name}'s ${skill.name} level to ${level}` };
  }
  await INSERT.into('resourceagent.EmployeeSkills').entries({ employeeId: emp.ID, skillId: skill.ID, level });
  return { success: true, message: `Assigned ${skill.name} (level ${level}) to ${emp.name}` };
}

async function createProject({ name, description, startDate, endDate, status }) {
  const id = 'p' + Date.now();
  await INSERT.into('resourceagent.Projects').entries({ ID: id, name, description: description || '', startDate, endDate, status });
  return { success: true, message: `Project "${name}" created with ID ${id}` };
}

async function updateProject({ projectName, name, description, startDate, endDate, status }) {
  const projects = await SELECT.from('resourceagent.Projects').where(`lower(name) like lower('%${projectName}%')`);
  if (!projects.length) return { error: `No project found matching "${projectName}"` };

  const proj = projects[0];
  const updates = {};
  if (name)        updates.name        = name;
  if (description) updates.description = description;
  if (startDate)   updates.startDate   = startDate;
  if (endDate)     updates.endDate     = endDate;
  if (status)      updates.status      = status;

  await UPDATE('resourceagent.Projects').set(updates).where({ ID: proj.ID });
  return { success: true, message: `Project "${proj.name}" updated: ${JSON.stringify(updates)}` };
}

async function createEmployee({ name, email, seniority }) {
  const id = 'e' + Date.now();
  await INSERT.into('resourceagent.Employees').entries({ ID: id, name, email, seniority });
  return { success: true, message: `Employee "${name}" created with ID ${id}` };
}

async function deleteEmployee({ employeeName }) {
  const employees = await SELECT.from('resourceagent.Employees').where(`lower(name) like lower('%${employeeName}%')`);
  if (!employees.length) return { error: `No employee found matching "${employeeName}"` };

  const emp = employees[0];
  await DELETE.from('resourceagent.Assignments').where({ employeeId: emp.ID });
  await DELETE.from('resourceagent.EmployeeSkills').where({ employeeId: emp.ID });
  await DELETE.from('resourceagent.Employees').where({ ID: emp.ID });
  return { success: true, message: `Employee "${emp.name}" and all their assignments have been deleted` };
}

async function getAssignmentSkills({ employeeName, projectName }) {
  // Fuzzy match employee and project
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

  // Resolve skill names to IDs (create if needed)
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

// ── Tool dispatcher ───────────────────────────────────────────────────────────

async function dispatchTool(name, input) {
  switch (name) {
    case 'getEmployeeList':          return getEmployeeList();
    case 'getEmployeeProfile':       return getEmployeeProfile(input);
    case 'getEmployeeTimeline':      return getEmployeeTimeline(input);
    case 'getAvailableEmployees':    return getAvailableEmployees(input);
    case 'matchEmployeesForProject': return matchEmployeesForProject(input);
    case 'getProjectList':           return getProjectList(input);
    case 'createAssignment':         return createAssignment(input);
    case 'updateAssignment':         return updateAssignment(input);
    case 'deleteAssignment':         return deleteAssignment(input);
    case 'createSkill':              return createSkill(input);
    case 'assignSkillToEmployee':    return assignSkillToEmployee(input);
    case 'createProject':            return createProject(input);
    case 'updateProject':            return updateProject(input);
    case 'createEmployee':           return createEmployee(input);
    case 'deleteEmployee':           return deleteEmployee(input);
    case 'getAssignmentSkills':      return getAssignmentSkills(input);
    case 'setAssignmentSkills':      return setAssignmentSkills(input);
    default: return { error: `Unknown tool: ${name}` };
  }
}

// ── Agent conversation loop ───────────────────────────────────────────────────

async function runAgent(userMessage, conversationHistory = []) {
  const messages = [...conversationHistory, { role: 'user', content: userMessage }];
  const toolsUsed = [];
  const client = await getClient();
  const isBTP = !!process.env.VCAP_SERVICES;
  const model = isBTP
    ? (process.env.AICORE_MODEL || 'anthropic--claude-4.5-sonnet')
    : 'claude-sonnet-4-6';

  while (true) {
    const reqBody = { max_tokens: 4096, system: SYSTEM_PROMPT, tools: TOOLS, messages, anthropic_version: 'bedrock-2023-05-31' };
    const response = isBTP
      ? await callAICore(reqBody)
      : await client.messages.create({ model, ...reqBody, anthropic_version: undefined });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const replyText = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
      return { reply: replyText, toolsUsed, messages };
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        toolsUsed.push(block.name);
        const result = await dispatchTool(block.name, block.input);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: toolResults });
    }
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { runAgent };
