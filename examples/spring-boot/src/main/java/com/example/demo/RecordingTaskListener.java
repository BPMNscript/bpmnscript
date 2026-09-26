package com.example.demo;

import org.operaton.bpm.engine.delegate.DelegateTask;
import org.operaton.bpm.engine.delegate.Expression;
import org.operaton.bpm.engine.delegate.TaskListener;

/**
 * Records {@code <taskDefinitionKey>:<eventName>} and the injected
 * {@code marker}, if any, in the same {@link MarkerLog} the execution listener
 * writes, so both share one ordered record.
 */
public class RecordingTaskListener implements TaskListener {

    private Expression marker;

    @Override
    public void notify(DelegateTask delegateTask) {
        MarkerLog.append(delegateTask, delegateTask.getTaskDefinitionKey()
                + ":" + delegateTask.getEventName()
                + MarkerLog.injected(marker, delegateTask));
    }
}
