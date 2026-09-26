package com.example.demo;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.Expression;
import org.operaton.bpm.engine.delegate.JavaDelegate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The generic delegate: logs and continues. The engine injects {@code marker}
 * from the task's {@code field}; when set, its value goes into the
 * {@link MarkerLog} so what the engine set on the delegate is readable from
 * outside the JVM.
 */
public class LogDelegate implements JavaDelegate {

    private static final Logger LOG = LoggerFactory.getLogger(LogDelegate.class);

    private Expression marker;

    @Override
    public void execute(DelegateExecution execution) {
        LOG.info("LogDelegate [{}]: executed service task '{}' ({})",
                execution.getProcessInstanceId(),
                execution.getCurrentActivityName(),
                execution.getCurrentActivityId());

        if (marker != null) {
            MarkerLog.append(execution, execution.getCurrentActivityId()
                    + ":execute" + MarkerLog.injected(marker, execution));
        }
    }
}
