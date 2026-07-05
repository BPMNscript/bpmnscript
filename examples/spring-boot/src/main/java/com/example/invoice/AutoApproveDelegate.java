package com.example.invoice;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Service task delegate that automatically approves low-value invoices.
 *
 * <p>Referenced from the BPMNscript DSL source as:
 * <pre>service AutoApprove "Auto-approve" { class = "com.example.invoice.AutoApproveDelegate" }</pre>
 *
 * <p>Sets the process variable {@code autoApproved = true} so downstream tasks
 * and the testcontainers E2E harness can assert the correct branch was taken.
 */
public class AutoApproveDelegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(AutoApproveDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        LOG.info("AutoApproveDelegate executing for process instance {}; setting autoApproved=true",
                execution.getProcessInstanceId());
        execution.setVariable("autoApproved", true);
    }
}
