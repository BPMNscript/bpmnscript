package com.example.loan;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Service task delegate that records a rejected loan.
 *
 * <p>Referenced from the BPMNscript DSL source as:
 * <pre>service NotifyRejected "Notify rejected" { class = "com.example.loan.RejectDelegate" }</pre>
 *
 * <p>Sets {@code decision = "REJECTED"} — the visible end state when a human
 * approver declined the loan (or completed the task without approving it).
 */
public class RejectDelegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(RejectDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        execution.setVariable("decision", "REJECTED");
        LOG.info("Loan REJECTED [{}]", execution.getProcessInstanceId());
    }
}
