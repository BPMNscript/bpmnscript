package com.example.loan.kopp;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Seeds the conservative default for the Kopp loan-approval variant.
 *
 * <p>Sets {@code assessorRes = "high"} so the human-assessor variable always
 * exists before the final gateway reads {@code assessorRes == "low"}. The manual
 * assessment task overrides it to {@code "low"} when the assessor approves; if an
 * instance never reaches the assessor (internal rating not low) the default keeps
 * the gateway from referencing an undefined variable.
 */
public class InitDelegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(InitDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        execution.setVariable("assessorRes", "high");
        LOG.info("Init [{}]: seeded assessorRes=high", execution.getProcessInstanceId());
    }
}
