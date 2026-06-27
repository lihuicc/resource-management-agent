const cds = require('@sap/cds');

module.exports = cds.service.impl(async function () {
  const { Assignments } = this.entities;

  this.before('CREATE', Assignments, async (req) => {
    const { employeeId, startDate, endDate } = req.data;

    const overlapping = await SELECT.from(Assignments).where({
      employeeId,
      startDate: { '<=': endDate },
      endDate: { '>=': startDate }
    });

    if (overlapping.length >= 2) {
      req.error(400, `Employee already has 2 assignments overlapping this period`);
    }
  });
});
