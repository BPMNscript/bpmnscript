package com.example.demo;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.ExecutionListener;

/**
 * Execution listener that leaves a trace of itself in the process instance.
 *
 * Every invocation appends {@code <activityId>:<eventName>} to the process
 * variable {@code listenerLog}, comma separated, so a reader of that one
 * variable sees which lifecycle events the engine fired and in which order.
 * Registering the same class on both the start and the end of an activity
 * therefore yields two distinct markers.
 */
public class RecordingExecutionListener implements ExecutionListener {

    private static final String LOG_VARIABLE = "listenerLog";

    @Override
    public void notify(DelegateExecution execution) {
        String marker = execution.getCurrentActivityId() + ":" + execution.getEventName();
        Object recorded = execution.getVariable(LOG_VARIABLE);
        execution.setVariable(LOG_VARIABLE, recorded == null ? marker : recorded + "," + marker);
    }
}
