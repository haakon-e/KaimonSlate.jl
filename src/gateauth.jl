# How Slate reads KaimonGate's auth switches. Shared by the worker (worker.jl) and its unit test
# (test/test_gateauth.jl); pure and dependency-free, so the test can include it on its own.

# KaimonGate's own spelling, from `gate_serve.jl`. Kept in step deliberately: the two ends of one
# setting must not disagree about what the operator wrote. Anything else reads as false.
gate_truthy(v) = lowercase(strip(String(v))) in ("1", "true", "yes", "on")

# Does a CURVE channel allow-list its clients, or serve any peer holding the server's public key?
#
# Unset means enforce. This used to be read out of KaimonGate's internals, which are not
# module-level names in every release. The lookup threw, the `catch` answered "do not enforce", and
# a worker on such a release served its blob channel to whoever could reach the port. A control
# that cannot read its own setting has to fail closed.
#
# KaimonGate also takes this from its config file, which is not visible from here. When the two
# disagree this channel is the stricter of the two.
blob_enforce(env = ENV) = !gate_truthy(get(env, "KAIMON_GATE_CURVE_ALLOW_ANY", ""))
