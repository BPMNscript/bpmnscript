package com.example.demo;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Generic delegate for any service task that just needs to log and continue. */
public class LogDelegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(LogDelegate.class);

    @Override
    public void execute(DelegateExecution execution) {
        LOG.info("LogDelegate [{}]: executed service task '{}' ({})",
                execution.getProcessInstanceId(),
                execution.getCurrentActivityName(),
                execution.getCurrentActivityId());
    }
}
