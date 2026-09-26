package com.example.demo;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.ExecutionListener;
import org.operaton.bpm.engine.delegate.Expression;

/**
 * Records {@code <activityId>:<eventName>} and the injected {@code marker}, if
 * any, in the {@link MarkerLog}.
 */
public class RecordingExecutionListener implements ExecutionListener {

    private Expression marker;

    @Override
    public void notify(DelegateExecution execution) {
        MarkerLog.append(execution, execution.getCurrentActivityId()
                + ":" + execution.getEventName()
                + MarkerLog.injected(marker, execution));
    }
}
