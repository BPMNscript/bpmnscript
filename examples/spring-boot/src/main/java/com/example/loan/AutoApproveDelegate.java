package com.example.loan;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Service task delegate that auto-approves a low-risk small loan.
 *
 * <p>Referenced from the BPMNscript DSL source as:
 * <pre>service AutoApprove "Auto-approve" { class = "com.example.loan.AutoApproveDelegate" }</pre>
 *
 * <p>Sets {@code approved = true} so the final gateway routes to the "accepted"
 * branch without a human approver. Reached only when the loan is below the
 * automated threshold and the risk assessment returned {@code "low"}.
 */
public class AutoApproveDelegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(AutoApproveDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        execution.setVariable("approved", true);
        LOG.info("AutoApprove [{}]: low-risk small loan -> approved=true",
                execution.getProcessInstanceId());
    }
}
