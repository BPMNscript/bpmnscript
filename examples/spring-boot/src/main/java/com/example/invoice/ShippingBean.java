package com.example.invoice;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * The {@code ${shippingBean.quote(order)}} expression in
 * {@code service-expression.bpmnscript} resolves to this bean by name.
 */
@Component("shippingBean")
public class ShippingBean {

    private static final Logger LOG = LoggerFactory.getLogger(ShippingBean.class);

    public double quote(Object order) {
        double amount = 9.99;
        LOG.info("ShippingBean.quote(order={}) -> {}", order, amount);
        return amount;
    }
}
