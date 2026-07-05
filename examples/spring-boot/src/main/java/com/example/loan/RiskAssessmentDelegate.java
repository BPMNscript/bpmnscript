package com.example.loan;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class RiskAssessmentDelegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(RiskAssessmentDelegate.class);

    private static final long LOW_RISK_THRESHOLD = 600;

    @Override
    public void execute(DelegateExecution execution) {
        Number score = (Number) execution.getVariable("creditScore");
        long creditScore = score == null ? 0 : score.longValue();

        String risk = creditScore >= LOW_RISK_THRESHOLD ? "low" : "high";
        execution.setVariable("risk", risk);

        LOG.info("RiskAssessment [{}]: creditScore={} -> risk={}",
                execution.getProcessInstanceId(), creditScore, risk);
    }
}
