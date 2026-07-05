package com.example.loan;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class RejectDelegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(RejectDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        execution.setVariable("decision", "REJECTED");
        LOG.info("Loan REJECTED [{}]", execution.getProcessInstanceId());
    }
}
