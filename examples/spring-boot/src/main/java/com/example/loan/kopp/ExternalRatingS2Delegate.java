package com.example.loan.kopp;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** External credit bureau S2: rates by loan size. */
public class ExternalRatingS2Delegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(ExternalRatingS2Delegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        Number amt = (Number) execution.getVariable("amount");
        long amount = amt == null ? Long.MAX_VALUE : amt.longValue();
        String rating = amount <= 50000 ? "low" : "high";
        execution.setVariable("extRes2", rating);
        LOG.info("ExternalS2 [{}]: amount={} -> extRes2={}",
                execution.getProcessInstanceId(), amount, rating);
    }
}
