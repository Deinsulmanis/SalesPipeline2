"""Insurance agencies: turn the owner's GetLeads upload results into the export column shape gl_export_pick.py reads.

Usage: python3 -I gl_upload_normalize.py <kind> <in_csv> <out_csv>
  kind = batch     decision-makers batch link result (source_domain, work_email, current_title, org_domain,
                   current_company_website, contact_city / contact_state, employee_count_range)
  kind = names     Names + companies enrichment (first_name, last_name, company_name, company_domain + enriched_* columns)
Only these columns are written: first_name, last_name, work_email, email_status, current_title, company_domain (the
agency the row was looked up for), current_employer_website (where the person works now, for the moved check),
employee_count_range, contact_city, contact_state. Personal emails and phone numbers are never read or written.
Rows with no work email are dropped. Prints counts only.
"""
import csv, json, sys

COLS = ["first_name", "last_name", "work_email", "email_status", "current_title", "company_domain",
        "current_employer_website", "employee_count_range", "contact_city", "contact_state"]


def batch(r):
    return dict(first_name=r.get("first_name"), last_name=r.get("last_name"), work_email=r.get("work_email"),
                email_status=r.get("email_status"), current_title=r.get("current_title"), company_domain=r.get("source_domain"),
                current_employer_website=r.get("current_company_website") or r.get("org_domain"),
                employee_count_range=r.get("employee_count_range"), contact_city=r.get("contact_city"), contact_state=r.get("contact_state"))


def names(r):
    return dict(first_name=r.get("enriched_first_name") or r.get("first_name"), last_name=r.get("enriched_last_name") or r.get("last_name"),
                work_email=r.get("enriched_work_email"), email_status=r.get("enriched_email_status"), current_title=r.get("enriched_job_title"),
                company_domain=r.get("company_domain"),
                current_employer_website=r.get("enriched_current_company_website") or r.get("enriched_org_domain"),
                employee_count_range=r.get("enriched_employee_count_range"), contact_city=r.get("enriched_location_city"),
                contact_state=r.get("enriched_location_state"))


def main():
    kind, src, dst = sys.argv[1:4]
    conv = {"batch": batch, "names": names}[kind]
    rows = list(csv.DictReader(open(src, newline="", encoding="utf-8-sig")))
    out = [conv(r) for r in rows]
    out = [o for o in out if (o["work_email"] or "").strip()]
    with open(dst, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLS)
        w.writeheader()
        w.writerows(out)
    print(json.dumps({"kind": kind, "rows_in": len(rows), "rows_with_work_email": len(out)}))


if __name__ == "__main__":
    main()
