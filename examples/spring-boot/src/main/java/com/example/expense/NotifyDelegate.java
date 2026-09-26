package com.example.expense;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class NotifyDelegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(NotifyDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        LOG.info("Notify [{}]: the claimant is told the claim is settled",
                execution.getProcessInstanceId());
    }
}
