package com.example.loan;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Service task delegate that records an accepted loan.
 *
 * <p>Referenced from the BPMNscript DSL source as:
 * <pre>service NotifyAccepted "Notify accepted" { class = "com.example.loan.AcceptDelegate" }</pre>
 *
 * <p>Sets {@code decision = "ACCEPTED"} — the visible end state of an approved
 * loan, whether it was auto-approved or approved by a human.
 */
public class AcceptDelegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(AcceptDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        execution.setVariable("decision", "ACCEPTED");
        LOG.info("Loan ACCEPTED [{}]", execution.getProcessInstanceId());
    }
}
