package com.example.loan;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class InitDelegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(InitDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        execution.setVariable("approved", false);
        LOG.info("Init [{}]: seeded approved=false", execution.getProcessInstanceId());
    }
}
