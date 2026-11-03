# -*- coding: utf-8 -*-
"""Reference logic for jole-outreach-readiness 1.0.0. SKILL.md wins any disagreement.

Inputs:
  icp, dedupe, feasibility, buyer, contact   labels from the owning skills, or NOT EVALUATED
  credit_hold        bool (ICP credit hold)
  open_conditions    bool (feasibility FEASIBLE WITH CONDITIONS still unconfirmed)
  existing_in_sequence bool (dedupe EXISTING CONTACT already in a sequence or held)
  approach           1..5
  evidence           {"verified_role": str, "verified_location": str, "checked_days": int,
                      "signal_status": str, "signal_checked_days": int}
  list_basis         signal | general
  approvals          extra approved sequences, e.g. {"general_craft_for_signal_lists", "signal_variant_2"}
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                                'jolesbtxicpskill', 'tests'))
import jole_common as C  # noqa: E402

HIRING_FRESHNESS_DAYS = 30      # production jole-personalization.js FRESHNESS_DAYS
SIGNAL_REUSE_DAYS = 90          # shared policy section 7
NE = C.NOT_EVALUATED


def hiring_modes(verified_role, verified_location, checked_days):
    """V5 hiring modes a lead may claim. [] means no hiring claim."""
    if not verified_role or checked_days is None or checked_days > HIRING_FRESHNESS_DAYS:
        return []
    return ['exact', 'role_only'] if verified_location else ['role_only']


def copy_fit(approach, evidence, list_basis='general', approvals=()):
    """(supported, sequence or '', reason)."""
    ev = evidence or {}
    if approach == 1:
        modes = hiring_modes(ev.get('verified_role'), ev.get('verified_location'), ev.get('checked_days'))
        if not modes:
            return False, '', 'no verified craft posting checked within 30 days'
        return True, 'v5_' + modes[0], ''
    if approach in (2, 3, 4):
        live = ev.get('signal_status') in ('VERIFIED CURRENT SIGNAL', 'VERIFIED FUTURE SIGNAL')
        fresh = ev.get('signal_checked_days') is not None and ev['signal_checked_days'] <= SIGNAL_REUSE_DAYS
        if not (live and fresh):
            return False, '', 'signal not verified and fresh'
        if 'signal_variant_%d' % approach not in approvals:
            return False, '', 'no approved sequence for approach %d' % approach
        return True, 'signal_variant_%d' % approach, ''
    if approach == 5:
        if list_basis == 'signal' and 'general_craft_for_signal_lists' not in approvals:
            return False, '', 'general_craft not approved for a signal-sourced list'
        return True, 'v5_general_craft', ''
    raise ValueError('approach must be 1 to 5')


def decide(f):
    """Return (label, reason, sequence)."""
    icp, dedupe = f.get('icp', NE), f.get('dedupe', NE)
    feas, buyer, contact = f.get('feasibility', NE), f.get('buyer', NE), f.get('contact', NE)
    if icp == 'EXCLUDED' or dedupe == 'PROHIBITED' or feas == 'BLOCKED BY VERIFIED REQUIREMENT':
        return 'EXCLUDED', 'excluded, prohibited or blocked', ''
    if dedupe in ('SUPPRESSED', 'FAMILY MATCH — REVIEW') or (dedupe == 'EXISTING CONTACT' and f.get('existing_in_sequence', True)):
        return 'HOLD', 'dedupe: ' + dedupe, ''
    if icp == 'CONDITIONAL' or f.get('credit_hold'):
        return 'HOLD', 'ICP gap or credit hold open', ''
    if feas == 'UNKNOWN' or (feas == 'FEASIBLE WITH CONDITIONS' and f.get('open_conditions', True)):
        return 'HOLD', 'feasibility unresolved', ''
    if contact == 'HOLD':
        return 'HOLD', 'contact on a sending-quality hold', ''
    if buyer != 'BUYER VERIFIED' or contact != 'CONTACT ACCEPTED FOR REVIEW':
        return 'CONTACT VERIFICATION REQUIRED', 'no accepted contact for a verified buyer', ''
    ok, sequence, why = copy_fit(f.get('approach', 5), f.get('evidence'), f.get('list_basis', 'general'),
                                 set(f.get('approvals', ())))
    if not ok:
        return 'COPY / SIGNAL REVIEW REQUIRED', why, ''
    return 'READY FOR APPROVED SEQUENCE', 'human review before any import or send', sequence
