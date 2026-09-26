package com.example.expense;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class BookPaymentDelegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(BookPaymentDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        LOG.info("BookPayment [{}]: amount={}",
                execution.getProcessInstanceId(), execution.getVariable("amount"));
    }
}
