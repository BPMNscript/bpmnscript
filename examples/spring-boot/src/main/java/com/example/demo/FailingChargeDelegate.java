package com.example.demo;

import org.operaton.bpm.engine.delegate.BpmnError;
import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The {@code failCharge} process variable lets one deployment drive both a
 * failing and a clean run.
 */
public class FailingChargeDelegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(FailingChargeDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        Object failCharge = execution.getVariable("failCharge");
        if (Boolean.TRUE.equals(failCharge)) {
            throw new BpmnError("CHARGE_FAILED");
        }
        LOG.info("FailingChargeDelegate [{}]: executed service task '{}' ({})",
                execution.getProcessInstanceId(),
                execution.getCurrentActivityName(),
                execution.getCurrentActivityId());
    }
}
