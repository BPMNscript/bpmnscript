package com.example.loan.kopp;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Internal rating service: stricter credit-score cutoff than the external bureaus. */
public class InternalRatingDelegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(InternalRatingDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        Number score = (Number) execution.getVariable("creditScore");
        long creditScore = score == null ? 0 : score.longValue();
        String rating = creditScore >= 700 ? "low" : "high";
        execution.setVariable("intRes", rating);
        LOG.info("Internal [{}]: creditScore={} -> intRes={}",
                execution.getProcessInstanceId(), creditScore, rating);
    }
}
