/** The plan of corrections: the hosted edition's, in the community edition. The report never has one here. */
const ABSENT = Object.freeze({ plan: null, loading: false, absent: true, expected: false, setAccepted: () => {} });

export const useRepairPlan = () => ABSENT;
