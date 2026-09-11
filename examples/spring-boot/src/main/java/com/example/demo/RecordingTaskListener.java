package com.example.demo;

import org.operaton.bpm.engine.delegate.DelegateTask;
import org.operaton.bpm.engine.delegate.Expression;
import org.operaton.bpm.engine.delegate.TaskListener;

/**
 * Task listener that leaves a trace of itself in the process instance.
 *
 * It appends {@code <taskDefinitionKey>:<eventName>} to the same
 * {@link MarkerLog} {@link RecordingExecutionListener} writes, so execution and
 * task events share one ordered record, and appends the value of an injected
 * {@code marker} field where one is set.
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
