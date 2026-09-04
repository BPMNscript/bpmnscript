package com.example.demo;

import org.operaton.bpm.engine.delegate.DelegateTask;
import org.operaton.bpm.engine.delegate.TaskListener;

/**
 * Task listener that leaves a trace of itself in the process instance.
 *
 * It appends {@code <taskDefinitionKey>:<eventName>} to the same comma
 * separated {@code listenerLog} variable {@link RecordingExecutionListener}
 * writes, so execution and task events share one ordered record.
 */
public class RecordingTaskListener implements TaskListener {

    private static final String LOG_VARIABLE = "listenerLog";

    @Override
    public void notify(DelegateTask delegateTask) {
        String marker = delegateTask.getTaskDefinitionKey() + ":" + delegateTask.getEventName();
        Object recorded = delegateTask.getVariable(LOG_VARIABLE);
        delegateTask.setVariable(LOG_VARIABLE, recorded == null ? marker : recorded + "," + marker);
    }
}
