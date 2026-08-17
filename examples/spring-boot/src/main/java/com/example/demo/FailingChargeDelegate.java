package com.example.demo;

import org.operaton.bpm.engine.delegate.BpmnError;
import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Charges a payment, conditionally failing: when the process variable
 * {@code failCharge} is {@code true}, it raises a BPMN error with code
 * {@code CHARGE_FAILED} instead of completing; otherwise it logs and
 * continues like {@link LogDelegate}. The boolean gate lets one deployment
 * drive both a failing run and a clean pass-through run.
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
