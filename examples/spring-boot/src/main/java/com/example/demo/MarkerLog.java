package com.example.demo;

import org.operaton.bpm.engine.delegate.Expression;
import org.operaton.bpm.engine.delegate.VariableScope;

/**
 * The ordered trace of engine callbacks a process instance leaves behind, held
 * in one comma separated process variable so a single read shows what the
 * engine invoked and in which order.
 */
final class MarkerLog {

    private static final String VARIABLE = "listenerLog";

    private MarkerLog() {
    }

    /** Appends one marker, starting the record when nothing has written yet. */
    static void append(VariableScope scope, String marker) {
        Object recorded = scope.getVariable(VARIABLE);
        scope.setVariable(VARIABLE, recorded == null ? marker : recorded + "," + marker);
    }

    /**
     * The value of an injected field as a trailing marker segment, empty when
     * the binding carried no field.
     *
     * The field is declared as an {@link Expression} rather than as a
     * {@code String} because the engine hands both value forms over the same
     * slot: a literal arrives as a fixed value and a {@code ${...}} body as a
     * JUEL expression, and a field of any other type fails the deployment.
     */
    static String injected(Expression field, VariableScope scope) {
        return field == null ? "" : ":" + field.getValue(scope);
    }
}
