package com.example.loan;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Service task delegate that seeds the request's default variables.
 *
 * <p>Referenced from the BPMNscript DSL source as:
 * <pre>service InitRequest "Initialise request" { class = "com.example.loan.InitDelegate" }</pre>
 *
 * <p>Sets {@code approved = false} up front so the variable always exists before
 * the final gateway evaluates {@code ${approved == true}}. Without this default,
 * completing the human "Approve loan" task without supplying {@code approved}
 * leaves the variable undefined, and Operaton throws
 * {@code PropertyNotFoundException: Cannot resolve identifier 'approved'} — an
 * <em>undefined</em> variable is not the same as one set to {@code false}. The
 * auto-approve path still overrides this to {@code true}; the human path overrides
 * it when the approver chooses to accept.
 */
public class InitDelegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(InitDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        execution.setVariable("approved", false);
        LOG.info("Init [{}]: seeded approved=false", execution.getProcessInstanceId());
    }
}
