using { resourceagent } from '../db/schema';

service ResourceService @(path: '/api') {

  entity Employees as projection on resourceagent.Employees;
  entity Skills    as projection on resourceagent.Skills;
  entity Projects  as projection on resourceagent.Projects;

  entity EmployeeSkills as projection on resourceagent.EmployeeSkills;
  entity ProjectSkills  as projection on resourceagent.ProjectSkills;
  entity Assignments    as projection on resourceagent.Assignments;
  entity AssignmentSkills as projection on resourceagent.AssignmentSkills;
}
