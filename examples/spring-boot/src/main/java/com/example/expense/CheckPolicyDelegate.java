package com.example.expense;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class CheckPolicyDelegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(CheckPolicyDelegate.class);

    private static final double POLICY_LIMIT = 2000;

    @Override
    public void execute(DelegateExecution execution) {
        Number claimed = (Number) execution.getVariable("amount");
        double amount = claimed == null ? 0 : claimed.doubleValue();

        boolean compliant = amount > 0 && amount <= POLICY_LIMIT;
        execution.setVariable("compliant", compliant);

        LOG.info("CheckPolicy [{}]: amount={} -> compliant={}",
                execution.getProcessInstanceId(), amount, compliant);
    }
}
