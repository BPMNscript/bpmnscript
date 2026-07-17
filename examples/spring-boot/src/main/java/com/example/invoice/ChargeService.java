package com.example.invoice;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Bean referenced by the payment-charge process via
 * {@code delegate = "${chargeService}"} (operaton:delegateExpression). The bean
 * name "chargeService" is what the delegate expression resolves against.
 */
@Component("chargeService")
public class ChargeService implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(ChargeService.class);

    @Override
    public void execute(DelegateExecution execution) {
        execution.setVariable("charged", true);
        LOG.info("ChargeService [{}]: charged=true", execution.getProcessInstanceId());
    }
}
