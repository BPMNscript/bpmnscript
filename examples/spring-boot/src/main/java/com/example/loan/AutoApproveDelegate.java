package com.example.loan;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class AutoApproveDelegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(AutoApproveDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        execution.setVariable("approved", true);
        LOG.info("AutoApprove [{}]: low-risk small loan -> approved=true",
                execution.getProcessInstanceId());
    }
}
