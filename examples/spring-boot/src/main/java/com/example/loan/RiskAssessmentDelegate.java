package com.example.loan;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Service task delegate that screens a small loan and records a risk level.
 *
 * <p>Referenced from the BPMNscript DSL source as:
 * <pre>service AssessRisk "Assess risk" { class = "com.example.loan.RiskAssessmentDelegate" }</pre>
 *
 * <p>Reads the {@code creditScore} process variable and sets {@code risk} to
 * {@code "low"} when the score is at least 600, otherwise {@code "high"}. The
 * downstream gateway {@code amount < 10000 && risk == "low"} uses this to decide
 * whether the loan can be auto-approved or needs a human decision.
 */
public class RiskAssessmentDelegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(RiskAssessmentDelegate.class);

    /** Credit score at or above which a small loan is considered low risk. */
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
