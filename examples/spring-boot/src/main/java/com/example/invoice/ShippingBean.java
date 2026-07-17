package com.example.invoice;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Bean referenced by the shipping-quote process via
 * {@code expression = "${shippingBean.quote(order)}"} (operaton:expression). The
 * service task evaluates the method call; the returned quote is logged (the DSL
 * does not yet bind an expression result to a process variable).
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
