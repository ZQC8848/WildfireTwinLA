// Proposal copied from team contract. stepMinutes is NOT Eaton-calibrated.
export const SpreadParams = {
 ph:0.58,c1:0.045,c2:0.131,a:0.078,
 spot:{pBase:0.02,distMeanPerWindMs:40,samples:4},stepMinutes:5,
};
export const TreatmentEffect={break:{fuelMul:0.05},burn:{fuelMul:0.3},thin:{rosMul:0.5},zone0:{emberMul:0.3}};
// Explicit hackathon assumptions, not fitted Rothermel coefficients or quotes.
export const PlanningParams={baseRosMPerMinute:5,minRos:0.000001,maxRos:500,costPerCell:{break:100,burn:30,thin:60,zone0:250}};
