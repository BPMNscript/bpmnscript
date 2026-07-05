package com.example.loan.kopp;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** External credit bureau S1: rates by credit score. */
public class ExternalRatingS1Delegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(ExternalRatingS1Delegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        Number score = (Number) execution.getVariable("creditScore");
        long creditScore = score == null ? 0 : score.longValue();
        String rating = creditScore >= 600 ? "low" : "high";
        execution.setVariable("extRes1", rating);
        LOG.info("ExternalS1 [{}]: creditScore={} -> extRes1={}",
                execution.getProcessInstanceId(), creditScore, rating);
    }
}
