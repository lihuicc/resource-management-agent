namespace resourceagent;

entity Employees {
  key ID        : UUID;
  name          : String(100);
  email         : String(100);
  seniority     : String(20);  // T1 / T2 / T3 / T4
  skills        : Composition of many EmployeeSkills on skills.employeeId = $self.ID;
  assignments   : Association to many Assignments on assignments.employeeId = $self.ID;
}

entity Skills {
  key ID   : UUID;
  name     : String(50);
}

entity EmployeeSkills {
  key employeeId : UUID;
  key skillId    : UUID;
  level          : Integer;  // 1-5
  employee       : Association to Employees on employee.ID = employeeId;
  skill          : Association to Skills on skill.ID = skillId;
}

entity Projects {
  key ID            : UUID;
  name              : String(100);
  description       : String(500);
  startDate         : Date;
  endDate           : Date;
  status            : String(20);  // active / booked / open
  techRequirements  : Composition of many ProjectSkills on techRequirements.projectId = $self.ID;
  assignments       : Association to many Assignments on assignments.projectId = $self.ID;
}

entity ProjectSkills {
  key projectId : UUID;
  key skillId   : UUID;
  project       : Association to Projects on project.ID = projectId;
  skill         : Association to Skills on skill.ID = skillId;
}

entity Assignments {
  key ID         : UUID;
  employeeId     : UUID;
  projectId      : UUID;
  startDate      : Date;
  endDate        : Date;
  employee       : Association to Employees on employee.ID = employeeId;
  project        : Association to Projects on project.ID = projectId;
}
