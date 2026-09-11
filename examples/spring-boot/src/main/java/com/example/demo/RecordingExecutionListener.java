package com.example.demo;

import org.operaton.bpm.engine.delegate.DelegateExecution;
import org.operaton.bpm.engine.delegate.ExecutionListener;
import org.operaton.bpm.engine.delegate.Expression;

/**
 * Execution listener that leaves a trace of itself in the process instance.
 *
 * Every invocation appends {@code <activityId>:<eventName>} to the
 * {@link MarkerLog}, so registering the same class on both the start and the
 * end of an activity yields two distinct markers. A listener carrying an
 * injected {@code marker} field appends its value as a third segment, so the
 * record shows both that the listener ran and what the engine set on it before
 * it did.
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
