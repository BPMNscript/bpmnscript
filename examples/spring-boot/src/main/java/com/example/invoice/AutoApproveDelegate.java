package com.example.invoice;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class AutoApproveDelegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(AutoApproveDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        execution.setVariable("autoApproved", true);
        LOG.info("AutoApprove [{}]: autoApproved=true", execution.getProcessInstanceId());
    }
}
