// What another screen asks the validation report to open on (a rule, or its Diagnostic), taken once by the report.
let asked = null;

export const askReportOn = ({ rule = null, tab = null } = {}) => {
  asked = rule || tab ? { rule, tab } : null;
};

export const takeAskedReport = () => {
  const a = asked;
  asked = null;
  return a;
};
