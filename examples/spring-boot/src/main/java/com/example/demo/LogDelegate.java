package com.example.demo;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Generic, reusable service-task delegate for demo and test processes.
 *
 * <p>It logs the activity and continues — nothing process-specific. Point any
 * service task that just needs to "do something and move on" at it from the DSL:
 * <pre>service DoThing "Do thing" { class = "com.example.demo.LogDelegate" }</pre>
 *
 * <p>This lets you drop a new {@code .bpmnscript} into {@code processes/},
 * compile it, and run it on the engine without writing a bespoke delegate for
 * every service task. Processes that need real behaviour (set variables, call
 * out) still get their own delegate — see {@code com.example.loan}.
 */
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
